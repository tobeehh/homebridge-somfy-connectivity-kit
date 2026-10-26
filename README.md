# homebridge-somfy-connectivity-kit

Homebridge-Plugin für das **Somfy Connectivity Kit** (funktioniert auch mit Connexoon und TaHoma über die Somfy-Cloud).
Geschrieben und getestet für **Homebridge 2.x** (läuft auch auf 1.8+), Node.js 20/22/24, keine externen Abhängigkeiten.

## Was es kann

| Somfy-Gerät | HomeKit | Hinweis |
|---|---|---|
| Rollläden, Jalousien, Screens, Fenster, Vorhänge (io) | Fensterabdeckung mit Position | Position wird zurückgemeldet |
| Markisen / Pergola (io) | Fensterabdeckung (100 % = ausgefahren) | über `setDeployment` |
| RTS-Geräte (Rollläden, Markisen) | Fensterabdeckung | keine Rückmeldung: 0 % = zu, 100 % = auf, dazwischen = „My“-Position |
| Garagentor / Tor | Garagentoröffner | |
| Licht (io) | Lampe, ggf. dimmbar | |
| Zwischenstecker (io) | Schalter | |

Weitere Funktionen:
- Schieberegler werden entprellt, sodass nur der Endwert gesendet wird.
- „Stopp“ erfolgt über HoldPosition.
- Statusänderungen aus der Somfy-App oder vom Wandtaster kommen per Event-Abfrage (Standard alle 5 s).
- Es gibt einen automatischen Re-Login, ein Token-Refresh und eine Neuregistrierung des Event-Listeners.

## Installation

In der Homebridge-UI unter **Terminal** (oder per SSH auf dem Homebridge-Host):

```bash
cd /var/lib/homebridge        # bzw. dein Homebridge-Speicherpfad
npm install /pfad/zu/homebridge-somfy-connectivity-kit-1.0.0.tgz
```

Lade die `.tgz`-Datei vorher in der UI hoch oder kopiere sie per `scp` auf den Host. Starte danach Homebridge neu.
Deinstalliere vorher `homebridge-tahoma`, damit die Geräte nicht doppelt erscheinen.

## Konfiguration

Die Einstellungen lassen sich in der UI vornehmen. Alternativ geht es auch so:

```json
{
  "platform": "SomfyConnectivityKit",
  "name": "Somfy",
  "username": "deine@email.de",
  "password": "dein-passwort"
}
```

Optional:

| Option | Standard | Bedeutung |
|---|---|---|
| `gatewayId` | – | Nur bei mehreren Somfy-Boxen nötig, z. B. `1234-5678-9012` |
| `authMode` | `auto` | `auto`, `account` (aktuelles App-Login) oder `legacy` |
| `pollingInterval` | `5` | Sekunden zwischen den Event-Abfragen |
| `refreshInterval` | `30` | Minuten zwischen vollständigen Status-Abgleichen |
| `invert` | `[]` | Gerätenamen mit vertauschter Richtung |
| `exclude` | `[]` | Gerätenamen, URLs oder Typen (`Light`, `Awning` …), die ausgeblendet werden |

Empfehlung: Lass das Plugin als **Child Bridge** laufen (Plugin-Einstellungen → „Bridge Settings“).

## Fehlersuche

Setze den Debug-Modus in den Homebridge-Einstellungen. Das Plugin protokolliert dann jedes Kommando (`→ setClosure(30)`) und jede Statusänderung.
Erscheint im Log `Somfy login failed: wrong e-mail or password`, prüfe die Zugangsdaten der **TaHoma-App**.
Kommt `account login failed … falling back to legacy`, nutzt das Plugin automatisch das ältere Login-Verfahren.
