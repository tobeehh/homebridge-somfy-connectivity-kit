'use strict';

const COVER_CLASSES = new Set([
  'RollerShutter', 'Shutter', 'Screen', 'ExteriorScreen', 'Blind', 'VenetianBlind',
  'ExteriorVenetianBlind', 'Curtain', 'Window', 'Pergola', 'Awning', 'SwingingShutter',
]);
const GATE_CLASSES = new Set(['GarageDoor', 'Gate']);

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
    this.name = device.label || device.deviceURL;
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

  async exec(name, params = []) {
    this.log.info(`[${this.name}] → ${name}${params.length ? `(${params.join(', ')})` : ''}`);
    try {
      await this.platform.client.execute(this.deviceURL, name, params);
    } catch (e) {
      this.log.error(`[${this.name}] command ${name} failed: ${e.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** Called with an array of {name, value} state objects. */
  updateStates(stateList) {
    let changed = false;
    for (const s of stateList || []) {
      if (this.states[s.name] !== s.value) {
        this.states[s.name] = s.value;
        changed = true;
      }
    }
    if (changed) this.onStatesChanged();
  }

  onStatesChanged() {}
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

    this.service = accessory.getService(this.Service.WindowCovering) ||
      accessory.addService(this.Service.WindowCovering, this.name);

    const stored = accessory.context.lastPosition;
    this.position = this.readPosition();
    if (this.position === null) this.position = typeof stored === 'number' ? stored : 0;
    this.target = this.position;
    this.positionState = C.PositionState.STOPPED;
    this.debounce = null;
    this.moveTimer = null;

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

    if (this.mode === 'deployment') {
      await this.exec('setDeployment', [raw]);
    } else if (this.mode === 'closure') {
      await this.exec('setClosure', [100 - raw]);
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
    // Safety net: if no state event arrives, poll the device once it should have finished.
    clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => this.platform.refreshDevice(this), 90000);
  }

  async hold() {
    const C = this.Characteristic;
    await this.exec(this.has('stop') ? 'stop' : 'my');
    if (this.mode !== 'stateless') {
      this.positionState = C.PositionState.STOPPED;
      this.service.updateCharacteristic(C.PositionState, this.positionState);
      setTimeout(() => this.platform.refreshDevice(this), 3000);
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
      clearTimeout(this.moveTimer);
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

    const s = this.readOpen();
    const stored = accessory.context.lastOpen;
    this.open = s === null ? stored === true : s;
    this.targetOpen = this.open;

    this.service.getCharacteristic(C.CurrentDoorState).onGet(() => this.currentState());
    this.service.getCharacteristic(C.TargetDoorState)
      .onGet(() => (this.targetOpen ? C.TargetDoorState.OPEN : C.TargetDoorState.CLOSED))
      .onSet(async (v) => {
        this.targetOpen = v === C.TargetDoorState.OPEN;
        if (this.targetOpen) await this.exec(this.has('open') ? 'open' : 'cycle');
        else await this.exec(this.has('close') ? 'close' : 'cycle');
        if (this.readOpen() === null) {
          this.open = this.targetOpen; // stateless (RTS)
        }
        this.push();
      });
    this.service.getCharacteristic(C.ObstructionDetected).onGet(() => false);
    this.push();
  }

  readOpen() {
    const v = this.states['core:OpenClosedState'] ?? this.states['core:OpenClosedPedestrianState'] ??
      this.states['core:OpenClosedUnknownState'];
    if (v === 'open' || v === 'pedestrian' || v === 'partial') return true;
    if (v === 'closed') return false;
    return null;
  }

  currentState() {
    const C = this.Characteristic;
    if (this.open === this.targetOpen) return this.open ? C.CurrentDoorState.OPEN : C.CurrentDoorState.CLOSED;
    return this.targetOpen ? C.CurrentDoorState.OPENING : C.CurrentDoorState.CLOSING;
  }

  push() {
    const C = this.Characteristic;
    this.accessory.context.lastOpen = this.open;
    this.service.updateCharacteristic(C.TargetDoorState, this.targetOpen ? C.TargetDoorState.OPEN : C.TargetDoorState.CLOSED);
    this.service.updateCharacteristic(C.CurrentDoorState, this.currentState());
  }

  onStatesChanged() {
    const o = this.readOpen();
    if (o === null) return;
    this.open = o;
    this.targetOpen = o;
    this.push();
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

module.exports = { handlerFor, uiClassOf };
