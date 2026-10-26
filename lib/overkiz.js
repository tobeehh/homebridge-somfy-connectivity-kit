'use strict';

/**
 * Minimal client for the Somfy / Overkiz cloud API ("enduserAPI").
 *
 * Two login flows are supported:
 *  - "account": current TaHoma-app flow. Somfy Accounts password grant ->
 *    Keycloak ("Ginaite") token exchange -> site directory (BOB) -> site-scoped token.
 *  - "legacy":  Somfy Accounts password grant, Bearer token used directly
 *    against ha101-1.overkiz.com.
 * "auto" (default) tries "account" first and falls back to "legacy".
 */

const DEFAULT_URLS = Object.freeze({
  somfyApi: 'https://accounts.somfy.com',
  ginaiteToken: 'https://ginaite-prod.ovkube.net/realms/somfy-tahoma/protocol/openid-connect/token',
  bobApi: 'https://backoffice-service.ovkube.net/site-api/public/v1',
  endpoints: {
    EMEA: 'https://ha101-1.overkiz.com/enduser-mobile-web/enduserAPI/',
    APAC: 'https://ha201-1.overkiz.com/enduser-mobile-web/enduserAPI/',
    SNABA: 'https://ha401-1.overkiz.com/enduser-mobile-web/enduserAPI/',
  },
});

// Public client credentials of the TaHoma app (same values used by pyoverkiz / Home Assistant).
const CLIENT_ID = '0d8e920c-1478-11e7-a377-02dd59bd3041_1ewvaqmclfogo4kcsoo0c8k4kso884owg08sg8c40sk4go4ksg';
const CLIENT_SECRET = '12k73w1n540g8o4cokg0cw84cog840k84cwggscwg884004kgk';
const BOB_API_KEY = '184638B3FBE874ACD24C14FBD657B';

const COUNTRY_REGION = {
  CA: 'SNABA', US: 'SNABA', MX: 'SNABA',
  AU: 'APAC', HK: 'APAC', IN: 'APAC', ID: 'APAC', JP: 'APAC', MY: 'APAC', NZ: 'APAC',
  PH: 'APAC', SG: 'APAC', TW: 'APAC', TH: 'APAC', VN: 'APAC', KR: 'APAC', CN: 'APAC',
};

const REQUEST_TIMEOUT_MS = 20000;

class OverkizError extends Error {
  constructor(message, { status, errorCode, body } = {}) {
    super(message);
    this.name = 'OverkizError';
    this.status = status;
    this.errorCode = errorCode;
    this.body = body;
  }
}

class OverkizClient {
  /**
   * @param {object} opts
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {'auto'|'account'|'legacy'} [opts.authMode]
   * @param {string} [opts.gatewayId]  pin to one gateway if the account has several
   * @param {object} [opts.urls]       override endpoints (testing)
   * @param {object} opts.log          homebridge logger
   */
  constructor(opts) {
    this.username = opts.username;
    this.password = opts.password;
    this.authMode = opts.authMode || 'auto';
    this.gatewayId = opts.gatewayId || null;
    this.log = opts.log;
    const o = opts.urls || {};
    this.urls = {
      somfyApi: o.somfyApi || DEFAULT_URLS.somfyApi,
      ginaiteToken: o.ginaiteToken || DEFAULT_URLS.ginaiteToken,
      bobApi: o.bobApi || DEFAULT_URLS.bobApi,
      endpoints: { ...DEFAULT_URLS.endpoints, ...(o.endpoints || {}) },
    };

    this.flow = null;          // 'account' | 'legacy'
    this.endpoint = null;
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.siteOid = null;
    this.selectedGateway = null;
    this._authPromise = null;
  }

  // ---------------------------------------------------------------- HTTP

  async _fetch(url, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      const msg = e.name === 'AbortError' ? `Timeout after ${REQUEST_TIMEOUT_MS} ms` : e.message;
      throw new OverkizError(`Network error on ${url}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  static async _readBody(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async _form(url, fields) {
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
    const body = await OverkizClient._readBody(res);
    return { res, body };
  }

  // ---------------------------------------------------------------- Auth

  async _passwordToken() {
    const { res, body } = await this._form(`${this.urls.somfyApi}/oauth/oauth/v2/token/jwt`, {
      grant_type: 'password',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      username: this.username,
      password: this.password,
    });
    if (body && body.message === 'error.invalid.grant') {
      throw new OverkizError('Somfy login failed: wrong e-mail or password', { status: res.status, body });
    }
    if (!res.ok || !body || !body.access_token) {
      throw new OverkizError(`Somfy login failed (HTTP ${res.status})`, { status: res.status, body });
    }
    return body;
  }

  _applyToken(tok, fallbackLifetimeSec = 300) {
    this.accessToken = tok.access_token;
    if (tok.refresh_token) this.refreshToken = tok.refresh_token;
    const lifetime = Number(tok.expires_in) > 0 ? Number(tok.expires_in) : fallbackLifetimeSec;
    this.expiresAt = Date.now() + lifetime * 1000;
  }

  async _ginaiteExchange(ssoAccessToken) {
    const { res, body } = await this._form(this.urls.ginaiteToken, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: CLIENT_ID,
      subject_token: ssoAccessToken,
      subject_issuer: 'somfy-customer',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    });
    if (!res.ok || !body || !body.access_token) {
      throw new OverkizError(`Somfy token exchange failed (HTTP ${res.status})`, { status: res.status, body });
    }
    this._applyToken(body);
  }

  async _ginaiteRefresh(siteOid) {
    const url = siteOid
      ? `${this.urls.ginaiteToken}?siteOID=${encodeURIComponent(siteOid)}`
      : this.urls.ginaiteToken;
    const { res, body } = await this._form(url, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: this.refreshToken,
    });
    if (!res.ok || !body || !body.access_token) {
      throw new OverkizError(`Somfy token refresh failed (HTTP ${res.status})`, { status: res.status, body });
    }
    this._applyToken(body);
  }

  async _legacyRefresh() {
    const { res, body } = await this._form(`${this.urls.somfyApi}/oauth/oauth/v2/token/jwt`, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: this.refreshToken,
    });
    if (!res.ok || !body || !body.access_token) {
      throw new OverkizError(`Somfy token refresh failed (HTTP ${res.status})`, { status: res.status, body });
    }
    this._applyToken(body);
  }

  async _discoverSites() {
    const sites = [];
    for (let offset = 0; offset < 200; offset += 20) {
      const res = await this._fetch(`${this.urls.bobApi}/sites?withGateways=true&limit=20&offset=${offset}`, {
        headers: { Authorization: `Bearer ${this.accessToken}`, 'X-Api-Key': BOB_API_KEY, Accept: 'application/json' },
      });
      const body = await OverkizClient._readBody(res);
      if (!res.ok || !body) {
        throw new OverkizError(`Somfy site lookup failed (HTTP ${res.status})`, { status: res.status, body });
      }
      const results = Array.isArray(body.results) ? body.results : [];
      for (const site of results) {
        for (const sub of site.subSites || []) {
          if (sub.gateways && sub.gateways.length) {
            sites.push({
              gatewayId: sub.gateways[0].gatewayId,
              allGatewayIds: sub.gateways.map((g) => g.gatewayId),
              siteOid: site.siteOID,
              name: site.name,
              country: site.country,
            });
          }
        }
      }
      const total = Number(body.totalCount) || 0;
      if (!results.length || offset + results.length >= total) break;
    }
    return sites;
  }

  async _accountLogin() {
    const sso = await this._passwordToken();
    await this._ginaiteExchange(sso.access_token);
    const sites = await this._discoverSites();
    if (!sites.length) {
      throw new OverkizError('No Somfy gateway found on this account');
    }
    let site = sites[0];
    if (this.gatewayId) {
      const wanted = this.gatewayId.trim();
      const match = sites.find((s) => s.allGatewayIds.includes(wanted));
      if (!match) {
        throw new OverkizError(`Gateway "${wanted}" not found. Available: ${sites.map((s) => s.gatewayId).join(', ')}`);
      }
      site = match;
    } else if (sites.length > 1) {
      this.log.warn(
        `Account has ${sites.length} gateways (${sites.map((s) => `${s.gatewayId} "${s.name || ''}"`).join(', ')}); ` +
          `using ${site.gatewayId}. Set "gatewayId" in the config to choose another one.`,
      );
    }
    const region = COUNTRY_REGION[(site.country || '').toUpperCase()] || 'EMEA';
    this.siteOid = site.siteOid;
    this.selectedGateway = site.gatewayId;
    this.endpoint = this.urls.endpoints[region];
    await this._ginaiteRefresh(this.siteOid); // mint site-scoped token
    this.flow = 'account';
  }

  async _legacyLogin() {
    const tok = await this._passwordToken();
    this._applyToken(tok);
    this.endpoint = this.urls.endpoints.EMEA;
    this.flow = 'legacy';
  }

  async login() {
    if (this._authPromise) return this._authPromise;
    this._authPromise = (async () => {
      this.accessToken = null;
      this.refreshToken = null;
      if (this.authMode === 'legacy') {
        await this._legacyLogin();
      } else {
        try {
          await this._accountLogin();
        } catch (e) {
          if (this.authMode === 'account' || /wrong e-mail or password/.test(e.message)) throw e;
          this.log.warn(`Somfy account login failed (${e.message}) – falling back to legacy login.`);
          await this._legacyLogin();
        }
      }
      this.log.info(
        `Logged in to Somfy cloud (${this.flow} flow${this.selectedGateway ? `, gateway ${this.selectedGateway}` : ''}).`,
      );
    })().finally(() => {
      this._authPromise = null;
    });
    return this._authPromise;
  }

  async _ensureToken() {
    if (this._authPromise) await this._authPromise;
    if (!this.accessToken) return this.login();
    if (Date.now() < this.expiresAt - 30000) return undefined;
    if (!this.refreshToken) return this.login();
    this._authPromise = (async () => {
      try {
        if (this.flow === 'account') await this._ginaiteRefresh(this.siteOid);
        else await this._legacyRefresh();
        this.log.debug('Somfy access token refreshed.');
      } catch (e) {
        this.log.debug(`Token refresh failed (${e.message}), logging in again.`);
        this._authPromise = null;
        await this.login();
      }
    })().finally(() => {
      this._authPromise = null;
    });
    return this._authPromise;
  }

  // ---------------------------------------------------------------- API

  async request(method, path, payload, _retried = false) {
    await this._ensureToken();
    const init = {
      method,
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json' },
    };
    if (payload !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    const res = await this._fetch(this.endpoint + path, init);
    const body = await OverkizClient._readBody(res);
    if (res.status === 401 && !_retried) {
      this.log.debug(`HTTP 401 on ${path}, re-authenticating.`);
      this.expiresAt = 0;
      this.accessToken = null;
      return this.request(method, path, payload, true);
    }
    if (!res.ok) {
      const code = body && typeof body === 'object' ? body.errorCode : undefined;
      const detail = body && typeof body === 'object' ? body.error || body.errorCode : body;
      throw new OverkizError(`${method} ${path} failed (HTTP ${res.status}${detail ? `: ${detail}` : ''})`, {
        status: res.status,
        errorCode: code,
        body,
      });
    }
    return body;
  }

  getDevices() {
    return this.request('GET', 'setup/devices');
  }

  getDeviceStates(deviceURL) {
    return this.request('GET', `setup/devices/${encodeURIComponent(deviceURL)}/states`);
  }

  refreshDeviceStates(deviceURL) {
    return this.request('POST', `setup/devices/${encodeURIComponent(deviceURL)}/states/refresh`);
  }

  async execute(deviceURL, name, parameters = [], label = 'Homebridge') {
    const command = { name };
    if (parameters.length) command.parameters = parameters;
    const res = await this.request('POST', 'exec/apply', {
      label,
      actions: [{ deviceURL, commands: [command] }],
    });
    return res && res.execId;
  }

  async registerEvents() {
    const res = await this.request('POST', 'events/register');
    return res && res.id;
  }

  fetchEvents(listenerId) {
    return this.request('POST', `events/${listenerId}/fetch`);
  }

  async unregisterEvents(listenerId) {
    try {
      await this.request('POST', `events/${listenerId}/unregister`);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { OverkizClient, OverkizError, DEFAULT_URLS };
