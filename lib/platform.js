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

    // Same defaults as homebridge-tahoma / overkiz-client:
    //  - fetch events every 60 s, every 5 s while a command is running
    //  - ask the box to re-read all devices every 30 min (catches hand-held remote use)
    this.pollInterval = Math.max(10, Number(this.config.pollingInterval) || 60) * 1000;
    this.execPollInterval = 5000;
    this.fullRefreshInterval = Math.max(5, Number(this.config.refreshInterval) || 30) * 60 * 1000;
    this.executions = new Map(); // execId -> { callback, timer }
    this.pollBackoff = 10000;
    this.refreshLock = false;
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

  currentPollInterval() {
    return this.executions.size ? this.execPollInterval : this.pollInterval;
  }

  schedulePoll(delay = this.currentPollInterval()) {
    clearTimeout(this.pollTimer);
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    let delay;
    try {
      if (!this.listenerId) await this.registerEvents();
      const events = await this.client.fetchEvents(this.listenerId);
      this.handleEvents(Array.isArray(events) ? events : []);
      this.pollBackoff = 10000;
    } catch (e) {
      this.log.warn(`Polling error – ${e.message}`);
      // Listener gone (400/404) or session lost (401): register a new one on the next run.
      if ([400, 401, 404].includes(e.status) || e.errorCode === 'UNSPECIFIED_ERROR') this.listenerId = null;
      delay = this.pollBackoff;
      this.pollBackoff = Math.min(this.pollBackoff * 2, 10 * 60 * 1000);
    } finally {
      this.polling = false;
    }
    this.schedulePoll(delay);
  }

  /** Remember a running command; events are fetched every 5 s until it finishes (max. 2 min). */
  trackExecution(execId, callback) {
    if (!execId) return;
    const timer = setTimeout(() => this.finishExecution(execId, 'TIMED_OUT'), 2 * 60 * 1000);
    this.executions.set(execId, { callback, timer });
    if (this.listenerId) this.schedulePoll(this.execPollInterval);
  }

  finishExecution(execId, state, event) {
    const ex = this.executions.get(execId);
    if (!ex) return;
    clearTimeout(ex.timer);
    this.executions.delete(execId);
    if (state !== 'COMPLETED') this.log.debug(`Execution ${execId} ended: ${state}`);
    try {
      if (ex.callback) ex.callback(state, event);
    } catch (e) {
      this.log.debug(`Execution callback failed: ${e.message}`);
    }
  }

  handleEvents(events) {
    for (const ev of events) {
      if (ev.name === 'DeviceStateChangedEvent') {
        const h = this.handlers.get(ev.deviceURL);
        if (h) {
          this.log.debug(`[${h.name}] ${ev.deviceStates.map((s) => `${s.name}=${s.value}`).join(', ')}`);
          h.updateStates(ev.deviceStates);
        }
      } else if (ev.name === 'ExecutionStateChangedEvent') {
        if (ev.newState === 'FAILED') {
          this.log.warn(`Execution ${ev.execId} failed${ev.failureType ? `: ${ev.failureType}` : ''}`);
        }
        const ex = this.executions.get(ev.execId);
        const final = ev.timeToNextState === -1 || ['COMPLETED', 'FAILED'].includes(ev.newState);
        if (ex && ex.callback && !final) {
          try {
            ex.callback(ev.newState, ev);
          } catch (e) {
            this.log.debug(`Execution callback failed: ${e.message}`);
          }
        }
        if (final) {
          this.finishExecution(ev.execId, ev.newState, ev);
        }
      } else if (ev.name === 'RefreshAllDevicesStatesCompletedEvent') {
        this.log.debug('Refresh of all device states completed.');
        this.refreshLock = false;
        this.refreshAllFromCloud();
      }
    }
  }

  /**
   * Re-read a device's states. With ask=true (io devices only), the box is first told to query the
   * device over the air – otherwise the cloud only returns what it last heard, which misses
   * movements triggered by a hand-held remote.
   */
  async refreshDevice(handler, ask = false) {
    try {
      if (ask && ['io', 'ogp'].includes(handler.protocol)) {
        try {
          await this.client.refreshDeviceStates(handler.deviceURL);
          await new Promise((r) => setTimeout(r, 5000));
        } catch (e) {
          this.log.debug(`[${handler.name}] active status query failed: ${e.message}`);
        }
      }
      const states = await this.client.getDeviceStates(handler.deviceURL);
      handler.updateStates(states);
      if (handler.onStatesChanged) handler.onStatesChanged();
    } catch (e) {
      this.log.debug(`[${handler.name}] state refresh failed: ${e.message}`);
    }
  }

  /** Read the states the cloud currently holds for all devices. */
  async refreshAllFromCloud() {
    try {
      const devices = await this.client.getDevices();
      for (const d of devices || []) {
        const h = this.handlers.get(d.deviceURL);
        if (h) h.updateStates(d.states);
      }
    } catch (e) {
      this.log.debug(`Reading device states failed: ${e.message}`);
    }
  }

  /** Like homebridge-tahoma: ask the box to re-read every device, then pick up the result. */
  async refreshAll() {
    this.refreshLock = true;
    await this.client.refreshAllStates().catch((e) => this.log.debug(`Refresh request failed: ${e.message}`));
    // If RefreshAllDevicesStatesCompletedEvent doesn't arrive within 30 s, read the states anyway.
    setTimeout(() => {
      if (this.refreshLock) {
        this.refreshLock = false;
        this.refreshAllFromCloud();
      }
    }, 30000);
  }

  scheduleFullRefresh() {
    clearInterval(this.fullRefreshTimer);
    this.fullRefreshTimer = setInterval(() => this.refreshAll(), this.fullRefreshInterval);
  }

  async shutdown() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.fullRefreshTimer);
    for (const ex of this.executions.values()) clearTimeout(ex.timer);
    if (this.listenerId && this.client) await this.client.unregisterEvents(this.listenerId);
  }
}

module.exports = { SomfyPlatform, PLUGIN_NAME, PLATFORM_NAME };
