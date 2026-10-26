'use strict';

const { OverkizClient } = require('./overkiz');
const { handlerFor, uiClassOf, cleanName } = require('./accessories');

const PLUGIN_NAME = 'homebridge-somfy-connectivity-kit';
const PLATFORM_NAME = 'SomfyConnectivityKit';

class SomfyPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();   // UUID -> PlatformAccessory (from cache)
    this.handlers = new Map(); // deviceURL -> handler
    this.listenerId = null;
    this.stopped = false;
    this.pollTimer = null;
    this.fullRefreshTimer = null;

    this.pollInterval = Math.max(2, Number(this.config.pollingInterval) || 5) * 1000;
    this.fullRefreshInterval = Math.max(5, Number(this.config.refreshInterval) || 30) * 60 * 1000;
    this.exclude = (this.config.exclude || []).map((s) => String(s).toLowerCase().trim());
    this.invertList = (this.config.invert || []).map((s) => String(s).toLowerCase().trim());

    if (!this.config.username || !this.config.password) {
      this.log.error('Please set "username" and "password" (your Somfy / TaHoma app login) in the plugin config.');
      this.disabled = true;
      return;
    }

    this.client = new OverkizClient({
      username: this.config.username,
      password: this.config.password,
      authMode: this.config.authMode || 'auto',
      gatewayId: this.config.gatewayId,
      urls: this.config.apiOverrides, // undocumented, used for testing
      log: this.log,
    });

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.shutdown());
  }

  /** Called by Homebridge for each accessory restored from cache. */
  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  isInverted(name) {
    return this.invertList.includes(String(name).toLowerCase().trim());
  }

  isExcluded(device) {
    const keys = [device.label, device.deviceURL, uiClassOf(device), device.controllableName]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());
    return keys.some((k) => this.exclude.includes(k));
  }

  async start(attempt = 0) {
    if (this.disabled || this.stopped) return;
    try {
      await this.client.login();
      const devices = await this.client.getDevices();
      this.syncAccessories(Array.isArray(devices) ? devices : []);
      await this.registerEvents();
      this.schedulePoll();
      this.scheduleFullRefresh();
    } catch (e) {
      const delay = Math.min(300, 15 * 2 ** attempt);
      this.log.error(`Startup failed: ${e.message}. Retrying in ${delay}s.`);
      if (e.body) this.log.debug(`Response: ${JSON.stringify(e.body)}`);
      // Wrong credentials won't fix themselves – back off but keep trying slowly.
      setTimeout(() => this.start(attempt + 1), delay * 1000);
    }
  }

  syncAccessories(devices) {
    const seen = new Set();
    const toRegister = [];

    for (const device of devices) {
      const Handler = handlerFor(device);
      if (!Handler) {
        this.log.debug(`Skipping unsupported device "${device.label}" (${uiClassOf(device)}, ${device.controllableName})`);
        continue;
      }
      if (this.isExcluded(device)) {
        this.log.info(`Excluding "${device.label}" per config.`);
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.deviceURL}`);
      seen.add(uuid);

      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (isNew) {
        accessory = new this.api.platformAccessory(cleanName(device.label, uiClassOf(device)), uuid);
        toRegister.push(accessory);
      }
      accessory.context.deviceURL = device.deviceURL;
      accessory.context.handler = Handler.name;

      // Device type changed since it was cached → drop stale services.
      if (!isNew && accessory.context.handlerType && accessory.context.handlerType !== Handler.name) {
        for (const svc of [...accessory.services]) {
          if (!(svc instanceof this.api.hap.Service.AccessoryInformation)) accessory.removeService(svc);
        }
      }
      accessory.context.handlerType = Handler.name;

      const handler = new Handler(this, accessory, device);
      this.applyName(accessory, handler.name);
      this.handlers.set(device.deviceURL, handler);
      this.log.info(`${isNew ? 'Adding' : 'Restoring'} "${handler.name}" (${uiClassOf(device)}${handler.mode ? `, ${handler.mode}` : ''})`);
    }

    const existing = [...this.cached.values()].filter((a) => seen.has(a.UUID));
    if (existing.length) this.api.updatePlatformAccessories(existing);
    if (toRegister.length) this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toRegister);

    const stale = [...this.cached.values()].filter((a) => !seen.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.length} accessor${stale.length === 1 ? 'y' : 'ies'} no longer present.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) this.cached.delete(a.UUID);
    }
    for (const a of toRegister) this.cached.set(a.UUID, a);
    this.log.info(`${this.handlers.size} Somfy device(s) available in HomeKit.`);
  }

  /** Overwrite names restored from cache (older versions stored them unsanitised). */
  applyName(accessory, name) {
    const { Service, Characteristic } = this.api.hap;
    accessory.displayName = name;
    for (const svc of accessory.services) {
      if (svc.UUID === Service.AccessoryInformation.UUID || svc.testCharacteristic(Characteristic.Name)) {
        svc.displayName = name;
        svc.updateCharacteristic(Characteristic.Name, name);
      }
    }
  }

  // ------------------------------------------------------------------ events

  async registerEvents() {
    if (this.listenerId) await this.client.unregisterEvents(this.listenerId);
    this.listenerId = await this.client.registerEvents();
    this.log.debug(`Event listener registered: ${this.listenerId}`);
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollInterval);
  }

  async poll() {
    try {
      const events = await this.client.fetchEvents(this.listenerId);
      this.handleEvents(Array.isArray(events) ? events : []);
      this.pollErrors = 0;
    } catch (e) {
      this.pollErrors = (this.pollErrors || 0) + 1;
      this.log.debug(`Event fetch failed: ${e.message}`);
      if (e.errorCode === 'UNSPECIFIED_ERROR' || e.status === 400 || this.pollErrors >= 3) {
        // Listener expired (or session lost) – re-register.
        try {
          await this.registerEvents();
          this.pollErrors = 0;
        } catch (e2) {
          this.log.warn(`Could not re-register event listener: ${e2.message}`);
        }
      }
    }
    this.schedulePoll();
  }

  handleEvents(events) {
    for (const ev of events) {
      if (ev.name === 'DeviceStateChangedEvent') {
        const h = this.handlers.get(ev.deviceURL);
        if (h) {
          this.log.debug(`[${h.name}] ${ev.deviceStates.map((s) => `${s.name}=${s.value}`).join(', ')}`);
          h.updateStates(ev.deviceStates);
        }
      } else if (ev.name === 'ExecutionStateChangedEvent' && ev.newState === 'FAILED') {
        this.log.warn(`Execution ${ev.execId} failed${ev.failureType ? `: ${ev.failureType}` : ''}`);
        for (const url of Object.keys(ev.failedCommands || {})) {
          const h = this.handlers.get(url);
          if (h) this.refreshDevice(h);
        }
      }
    }
  }

  async refreshDevice(handler) {
    try {
      const states = await this.client.getDeviceStates(handler.deviceURL);
      handler.updateStates(states);
      if (handler.onStatesChanged) handler.onStatesChanged();
    } catch (e) {
      this.log.debug(`[${handler.name}] state refresh failed: ${e.message}`);
    }
  }

  scheduleFullRefresh() {
    clearInterval(this.fullRefreshTimer);
    this.fullRefreshTimer = setInterval(async () => {
      try {
        const devices = await this.client.getDevices();
        for (const d of devices || []) {
          const h = this.handlers.get(d.deviceURL);
          if (h) h.updateStates(d.states);
        }
      } catch (e) {
        this.log.debug(`Periodic refresh failed: ${e.message}`);
      }
    }, this.fullRefreshInterval);
  }

  async shutdown() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.fullRefreshTimer);
    if (this.listenerId && this.client) await this.client.unregisterEvents(this.listenerId);
  }
}

module.exports = { SomfyPlatform, PLUGIN_NAME, PLATFORM_NAME };
