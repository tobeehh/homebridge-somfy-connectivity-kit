'use strict';

const COVER_CLASSES = new Set([
  'RollerShutter', 'Shutter', 'Screen', 'ExteriorScreen', 'Blind', 'VenetianBlind',
  'ExteriorVenetianBlind', 'Curtain', 'Window', 'Pergola', 'Awning', 'SwingingShutter',
]);
const GATE_CLASSES = new Set(['GarageDoor', 'Gate']);
// States homebridge-tahoma reads for garage doors (first = preferred).
const GATE_STATES = ['core:OpenClosedPartialState', 'core:OpenClosedUnknownState', 'core:OpenClosedState'];

/** Pick the handler class for an Overkiz device, or null if unsupported. */
function handlerFor(device) {
  const ui = device.uiClass || (device.definition && device.definition.uiClass);
  if (COVER_CLASSES.has(ui)) return CoverAccessory;
  if (GATE_CLASSES.has(ui)) return GateAccessory;
  if (ui === 'Light') return LightAccessory;
  if (ui === 'OnOff') return SwitchAccessory;
  return null;
}

function uiClassOf(device) {
  return device.uiClass || (device.definition && device.definition.uiClass) || 'Unknown';
}

class BaseAccessory {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.Service = platform.api.hap.Service;
    this.Characteristic = platform.api.hap.Characteristic;
    this.accessory = accessory;
    this.device = device;
    this.deviceURL = device.deviceURL;
    this.name = cleanName(device.label, uiClassOf(device));
    this.commands = new Set(((device.definition && device.definition.commands) || []).map((c) => c.commandName));
    this.states = {};
    for (const s of device.states || []) this.states[s.name] = s.value;

    const info = accessory.getService(this.Service.AccessoryInformation) ||
      accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'Somfy')
      .setCharacteristic(this.Characteristic.Model, device.controllableName || uiClassOf(device))
      .setCharacteristic(this.Characteristic.SerialNumber, serialFrom(device.deviceURL));
  }

  has(cmd) {
    return this.commands.has(cmd);
  }

  get protocol() {
    return (this.deviceURL.split(':')[0] || '').toLowerCase();
  }

  /**
   * Send a command. onUpdate(state, event) is called with the execution states the cloud reports
   * (IN_PROGRESS, COMPLETED, FAILED, TIMED_OUT); while it runs, events are fetched every 5 s.
   */
  async exec(name, params = [], onUpdate) {
    this.log.info(`[${this.name}] → ${name}${params.length ? `(${params.join(', ')})` : ''}`);
    let execId;
    try {
      execId = await this.platform.client.execute(this.deviceURL, name, params);
    } catch (e) {
      this.log.error(`[${this.name}] command ${name} failed: ${e.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.platform.trackExecution(execId, onUpdate);
    return execId;
  }

  /** Called with an array of {name, value} state objects. */
  updateStates(stateList) {
    const changed = [];
    for (const s of stateList || []) {
      if (this.states[s.name] !== s.value) {
        this.states[s.name] = s.value;
        changed.push(s.name);
      }
    }
    if (changed.length) this.onStatesChanged(changed);
  }

  onStatesChanged() {}
}

/**
 * HomeKit names must start and end with a letter or number and may only contain
 * letters, numbers, spaces and common punctuation. Somfy labels often carry
 * padding ("Light          ") or underscores, so normalise them.
 */
function cleanName(label, fallback = 'Somfy') {
  let n = String(label || '')
    .replace(/[_]+/g, ' ')
    .replace(/[^\p{L}\p{N} '.,&()+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
  if (!n) n = String(fallback || 'Somfy').replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'Somfy';
  return n.slice(0, 64);
}

function serialFrom(url) {
  const parts = String(url).split('/');
  return parts[parts.length - 1] || String(url);
}

function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(Number(v))));
}

// ---------------------------------------------------------------------- Covers

class CoverAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const C = this.Characteristic;
    this.isAwning = uiClassOf(device) === 'Awning' || uiClassOf(device) === 'Pergola';
    this.invert = platform.isInverted(this.name);

    if (this.has('setDeployment')) this.mode = 'deployment';
    else if (this.has('setClosure')) this.mode = 'closure';
    else this.mode = 'stateless';
    this.hasFeedback = this.mode !== 'stateless';

    this.service = accessory.getService(this.Service.WindowCovering) ||
      accessory.addService(this.Service.WindowCovering, this.name);

    const stored = accessory.context.lastPosition;
    this.position = this.readPosition();
    if (this.position === null) this.position = typeof stored === 'number' ? stored : 0;
    this.target = this.position;
    this.positionState = C.PositionState.STOPPED;
    this.debounce = null;

    this.service.getCharacteristic(C.CurrentPosition).onGet(() => this.position);
    this.service.getCharacteristic(C.PositionState).onGet(() => this.positionState);
    this.service.getCharacteristic(C.TargetPosition)
      .onGet(() => this.target)
      .onSet((v) => this.setTarget(clamp(v)));

    if (this.has('stop') || this.has('my')) {
      this.service.getCharacteristic(C.HoldPosition).onSet((v) => {
        if (v) return this.hold();
        return undefined;
      });
    }
    this.push();
  }

  /** Current HomeKit position (0 = closed/retracted, 100 = open/deployed) from Overkiz state, or null. */
  readPosition() {
    let p = null;
    if (this.mode === 'deployment' && typeof this.states['core:DeploymentState'] === 'number') {
      p = this.states['core:DeploymentState'];
    } else if (this.mode === 'closure' && typeof this.states['core:ClosureState'] === 'number') {
      p = 100 - this.states['core:ClosureState'];
    } else if (this.mode === 'closure' && this.states['core:OpenClosedState'] !== undefined) {
      p = this.states['core:OpenClosedState'] === 'open' ? 100 : 0;
    }
    if (p === null) return null;
    p = clamp(p);
    return this.invert ? 100 - p : p;
  }

  push() {
    const C = this.Characteristic;
    this.accessory.context.lastPosition = this.position;
    this.service.updateCharacteristic(C.CurrentPosition, this.position);
    this.service.updateCharacteristic(C.TargetPosition, this.target);
    this.service.updateCharacteristic(C.PositionState, this.positionState);
  }

  setTarget(target) {
    this.target = target;
    clearTimeout(this.debounce);
    // HomeKit sliders send many values; only act on the last one. Return at once so
    // HomeKit doesn't wait on a superseded value; failures are logged by exec().
    this.debounce = setTimeout(() => {
      this.moveTo(this.target).catch(() => {
        this.target = this.position;
        this.positionState = this.Characteristic.PositionState.STOPPED;
        this.push();
      });
    }, 600);
  }

  async moveTo(target) {
    const C = this.Characteristic;
    const raw = this.invert ? 100 - target : target;

    const onUpdate = (state) => this.onExecution(state);
    if (this.mode === 'deployment') {
      await this.exec('setDeployment', [raw], onUpdate);
    } else if (this.mode === 'closure') {
      await this.exec('setClosure', [100 - raw], onUpdate);
    } else {
      // RTS: no position feedback – use open/close/my.
      if (raw >= 95) await this.exec(this.isAwning && this.has('deploy') ? 'deploy' : 'open');
      else if (raw <= 5) await this.exec(this.isAwning && this.has('undeploy') ? 'undeploy' : 'close');
      else if (this.has('my')) await this.exec('my');
      else await this.exec(raw >= 50 ? 'open' : 'close');
      // Assume the command succeeded.
      this.position = target;
      this.positionState = C.PositionState.STOPPED;
      this.push();
      return;
    }

    if (target !== this.position) {
      this.positionState = target > this.position ? C.PositionState.INCREASING : C.PositionState.DECREASING;
      this.service.updateCharacteristic(C.PositionState, this.positionState);
    }
  }

  /** Execution finished (or failed): stop the movement indicator, fall back to the real position. */
  onExecution(state) {
    if (!['COMPLETED', 'FAILED', 'TIMED_OUT'].includes(state)) return;
    this.positionState = this.Characteristic.PositionState.STOPPED;
    if (state !== 'COMPLETED') this.target = this.position;
    this.push();
  }

  async hold() {
    const C = this.Characteristic;
    await this.exec(this.has('stop') ? 'stop' : 'my');
    if (this.mode !== 'stateless') {
      this.positionState = C.PositionState.STOPPED;
      this.target = this.position;
      this.push();
    }
  }

  onStatesChanged() {
    const C = this.Characteristic;
    const p = this.readPosition();
    if (p === null) return;
    this.position = p;
    const moving = this.states['core:MovingState'] === true;
    if (!moving || Math.abs(this.target - p) <= 1) {
      this.positionState = C.PositionState.STOPPED;
      this.target = p;
    }
    this.push();
  }
}

// ---------------------------------------------------------------------- Garage door / gate

class GateAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const C = this.Characteristic;
    this.service = accessory.getService(this.Service.GarageDoorOpener) ||
      accessory.addService(this.Service.GarageDoorOpener, this.name);
    this.invert = platform.isInverted(this.name);

    // Logged at info level so users can report what their opener actually exposes.
    const stateInfo = Object.entries(this.states)
      .filter(([k]) => /OpenClosed|Closure|Position/.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    this.log.info(
      `[${this.name}] ${device.controllableName || 'Tor'} – Befehle: ${[...this.commands].join(', ') || 'keine'}; ` +
        `Zustand: ${stateInfo || 'keine Rückmeldung'}${this.invert ? ' (umgekehrt)' : ''}`,
    );

    // Same logic as homebridge-tahoma's GarageDoor mapper.
    this.cyclic = this.has('cycle');
    this.stateless = !GATE_STATES.some((n) => this.states[n] !== undefined);
    this.current = C.CurrentDoorState.CLOSED;
    this.target = C.TargetDoorState.CLOSED;
    for (const n of [...GATE_STATES].reverse()) {
      if (this.states[n] !== undefined) this.apply(this.states[n]);
    }

    this.service.getCharacteristic(C.CurrentDoorState).onGet(() => this.current);
    this.service.getCharacteristic(C.TargetDoorState)
      .onGet(() => this.target)
      .onSet((v) => this.setTargetState(v));
    this.service.getCharacteristic(C.ObstructionDetected).onGet(() => false);
    this.push();
  }

  async setTargetState(value) {
    const C = this.Characteristic;
    // HomeKit sometimes sends the same target several times within a second; Somfy then
    // cancels the duplicates (CMDCANCELLED). Send each target only once.
    const now = Date.now();
    if (this.lastSet && this.lastSet.value === value && now - this.lastSet.at < 5000) {
      this.log.debug(`[${this.name}] duplicate target ignored`);
      return;
    }
    this.lastSet = { value, at: now };
    const previousTarget = this.target;
    this.target = value;
    let cmd;
    if (this.cyclic) cmd = 'cycle';
    else cmd = value === C.TargetDoorState.CLOSED ? 'close' : 'open';

    await this.exec(cmd, [], (state, ev) => {
      switch (state) {
        case 'IN_PROGRESS':
          this.current = value === C.TargetDoorState.OPEN ? C.CurrentDoorState.OPENING : C.CurrentDoorState.CLOSING;
          this.push();
          break;
        case 'COMPLETED':
          if (this.stateless) {
            this.apply(value === C.TargetDoorState.CLOSED ? 'closed' : 'open', true);
            if (this.cyclic) setTimeout(() => this.apply('closed', true), 5000);
          } else if (this.cyclic) {
            // Ask the box to re-read the opener once it should have finished.
            setTimeout(() => this.platform.refreshDevice(this, true), 60000);
          }
          break;
        case 'FAILED':
          if (ev && ev.failureType === 'INTERNAL' && !this.stateless) {
            // Somfy reports many garage door runs as FAILED/INTERNAL although the door moved
            // (no confirmation from the opener). Keep the target and let the reported state decide.
            this.log.debug(`[${this.name}] execution ended with INTERNAL – checking actual state`);
            this.current = value === C.TargetDoorState.OPEN ? C.CurrentDoorState.OPEN : C.CurrentDoorState.CLOSED;
            this.push();
            this.platform.refreshDevice(this, true);
            setTimeout(() => this.platform.refreshDevice(this, true), 60000);
          } else {
            this.target = previousTarget;
            this.current = previousTarget === C.TargetDoorState.OPEN ? C.CurrentDoorState.OPEN : C.CurrentDoorState.CLOSED;
            this.push();
          }
          break;
        default:
          break;
      }
    });
  }

  /** Apply an Overkiz open/closed value ("open", "partial", "closed", "unknown"). */
  apply(value, raw = false) {
    const C = this.Characteristic;
    let v = value;
    if (this.invert && !raw) v = v === 'open' ? 'closed' : v === 'closed' ? 'open' : v;
    switch (v) {
      case 'open':
        this.current = C.CurrentDoorState.OPEN;
        this.target = C.TargetDoorState.OPEN;
        break;
      case 'partial':
        this.current = C.CurrentDoorState.STOPPED;
        this.target = C.TargetDoorState.OPEN;
        break;
      case 'closed':
        this.current = C.CurrentDoorState.CLOSED;
        this.target = C.TargetDoorState.CLOSED;
        break;
      default:
        return;
    }
    this.push();
  }

  push() {
    if (!this.service) return;
    const C = this.Characteristic;
    this.service.updateCharacteristic(C.TargetDoorState, this.target);
    this.service.updateCharacteristic(C.CurrentDoorState, this.current);
  }

  onStatesChanged(changed = []) {
    for (const n of changed) {
      if (GATE_STATES.includes(n)) this.apply(this.states[n]);
    }
  }
}

// ---------------------------------------------------------------------- Light

class LightAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const C = this.Characteristic;
    this.service = accessory.getService(this.Service.Lightbulb) ||
      accessory.addService(this.Service.Lightbulb, this.name);

    this.service.getCharacteristic(C.On)
      .onGet(() => this.isOn())
      .onSet(async (v) => {
        await this.exec(v ? 'on' : 'off');
        this.states['core:OnOffState'] = v ? 'on' : 'off';
      });

    if (this.has('setIntensity')) {
      this.service.getCharacteristic(C.Brightness)
        .onGet(() => clamp(this.states['core:LightIntensityState'] ?? 100))
        .onSet(async (v) => {
          await this.exec('setIntensity', [clamp(v)]);
          this.states['core:LightIntensityState'] = clamp(v);
        });
    }
  }

  isOn() {
    return this.states['core:OnOffState'] === 'on';
  }

  onStatesChanged() {
    const C = this.Characteristic;
    this.service.updateCharacteristic(C.On, this.isOn());
    if (this.has('setIntensity') && typeof this.states['core:LightIntensityState'] === 'number') {
      this.service.updateCharacteristic(C.Brightness, clamp(this.states['core:LightIntensityState']));
    }
  }
}

// ---------------------------------------------------------------------- Switch / plug

class SwitchAccessory extends BaseAccessory {
  constructor(platform, accessory, device) {
    super(platform, accessory, device);
    const C = this.Characteristic;
    this.service = accessory.getService(this.Service.Switch) ||
      accessory.addService(this.Service.Switch, this.name);
    this.service.getCharacteristic(C.On)
      .onGet(() => this.states['core:OnOffState'] === 'on')
      .onSet(async (v) => {
        await this.exec(v ? 'on' : 'off');
        this.states['core:OnOffState'] = v ? 'on' : 'off';
      });
  }

  onStatesChanged() {
    this.service.updateCharacteristic(this.Characteristic.On, this.states['core:OnOffState'] === 'on');
  }
}

module.exports = { handlerFor, uiClassOf, cleanName };
