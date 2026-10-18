# phRemote relay

Relay Node.js senza dipendenze esterne per i client phRemote. Richiede Node **22.21 o successivo**; i test usano il `WebSocket` integrato di Node. Il relay gestisce identità, richieste di connessione, approvazione e inoltro dei messaggi. Cattura schermo, input e crittografia appartengono ai client.

## Avvio locale

Dalla radice del progetto:

```sh
node server/index.mjs
```

Il processo ascolta su `127.0.0.1:8787`. `GET /health` restituisce `{"ok":true,"protocolVersion":1}`. WebSocket: `ws://127.0.0.1:8787/ws`. Gli altri percorsi HTTP restituiscono 404; non viene esposta alcuna directory. Il database locale `server/data/devices.json` è escluso dal controllo versione.

```sh
node --test tests/relay.test.mjs
```

I test aprono porte temporanee su loopback e verificano scambio reale di frame e messaggi, approvazione/rifiuto, isolamento delle sessioni, riconnessione e persistenza, limiti, heartbeat e gestione dei frame RFC 6455.

## Configurazione

| Variabile | Default | Uso |
| --- | --- | --- |
| `PHREMOTE_HOST` | `127.0.0.1` | Indirizzo di ascolto; `0.0.0.0` espone tutte le interfacce IPv4. |
| `PHREMOTE_PORT` | `8787` | Porta TCP. |
| `PHREMOTE_STORE` | `server/data/devices.json` | Percorso del database, relativo alla directory di avvio. |
| `PHREMOTE_ALLOWED_ORIGINS` | vuoto | Origini browser ammesse, separate da virgole e confrontate esattamente, ad esempio `https://remote.example.org`. |
| `PHREMOTE_TLS_CERT` | assente | Percorso del certificato PEM. Richiede anche la chiave. |
| `PHREMOTE_TLS_KEY` | assente | Percorso della chiave privata PEM. Richiede anche il certificato. |

Quando `PHREMOTE_PORT` non è impostata, il processo usa la variabile `PORT` della piattaforma, se presente; altrimenti mantiene il default 8787.

I client nativi senza header `Origin` sono ammessi. I browser devono usare un'origine esplicitamente configurata. L'header `Origin` non autentica un dispositivo: ciascuna riconnessione richiede comunque il relativo token.

Per collegamenti LAN o Internet usare `wss://` con un certificato riconosciuto dal client. Esempio di TLS gestito dal processo:

```sh
PHREMOTE_HOST=0.0.0.0 \
PHREMOTE_TLS_CERT=/percorso/fullchain.pem \
PHREMOTE_TLS_KEY=/percorso/privkey.pem \
node server/index.mjs
```

In alternativa un reverse proxy può terminare TLS e inoltrare `/ws` al relay in ascolto su loopback, mantenendo gli header di upgrade e un timeout inattività superiore a 60 secondi. Esempio Nginx all'interno di un virtual host HTTPS già configurato:

```nginx
location = /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
location = /health {
    proxy_pass http://127.0.0.1:8787;
}
```

Il processo non interpreta `X-Forwarded-For`: i limiti per IP dietro proxy si applicano all'indirizzo del proxy. Non aggiungere le credenziali dei dispositivi ai log del proxy. Distribuzione, DNS, certificati e apertura porte rimangono configurazioni dell'operatore.

## Protocollo WebSocket v1

Tutti i messaggi sono oggetti JSON in frame di testo. ID dispositivi: stringhe di **9 cifre**. `requestId` e `sessionId`: stringhe casuali opache; non costruirle lato client. Ogni socket deve registrarsi entro 15 secondi. È ammessa una sola richiesta pendente o sessione per dispositivo.

### Identità

Nuova identità, client → relay:

```json
{"type":"register","name":"Mac di Alice"}
```

Risposta:

```json
{"type":"registered","deviceId":"123456789","deviceToken":"token-base64url-43-caratteri","name":"Mac di Alice","protocolVersion":1}
```

Il token contiene 256 bit casuali ed è restituito **soltanto alla creazione**. Il client deve conservarlo in un archivio locale protetto. Per riconnettersi invia:

```json
{"type":"register","name":"Mac di Alice","deviceId":"123456789","deviceToken":"token-salvato"}
```

La risposta `registered` alla riconnessione omette `deviceToken`. La coppia ID/token viene verificata in tempo costante rispetto al confronto dell'hash. Il nome contiene da 1 a 80 caratteri e non ammette caratteri di controllo. Una riconnessione autenticata aggiorna il nome persistente e sostituisce il precedente socket del dispositivo, chiudendolo con codice 4001 e terminando eventuali richieste/sessioni precedenti.

Il database conserva solo SHA-256 dei token, ID e nomi. I file sono scritti con permessi `0600`, file temporaneo casuale, sincronizzazione e rename atomico. Un database esistente invalido impedisce l'avvio. Usare **una sola istanza del relay per database**; il formato non implementa scritture distribuite o multi processo.

### Richiesta, prova e approvazione

1. Viewer → relay: `{"type":"invite","hostId":"123456789"}`.
2. Relay → viewer: `{"type":"invited","requestId":"…","hostId":"123456789"}`.
3. Relay → host: `{"type":"incoming","requestId":"…","hostId":"123456789","viewerId":"987654321","viewerName":"Viewer"}`.
4. Host → relay: `{"type":"challenge","requestId":"…","challenge":{"publicKey":"…","salt":"…","nonce":"…"}}`.
5. Relay → viewer: `{"type":"challenge","requestId":"…","peerId":"123456789","challenge":{…}}`.
6. Viewer → relay: `{"type":"proof","requestId":"…","proof":{"publicKey":"…","mac":"…"}}`.
7. Relay → host: `{"type":"proof","requestId":"…","peerId":"987654321","proof":{…}}`.
8. Dopo verifica crittografica della prova e approvazione esplicita dell'utente, host → relay: `{"type":"accept","requestId":"…"}`.
9. Relay → ciascun partecipante: `{"type":"session","requestId":"…","sessionId":"…","peerId":"ID-altro-dispositivo","role":"host"}` oppure `"role":"viewer"`.

`challenge` e `proof` sono oggetti opachi al relay, ciascuno massimo 16 KiB JSON. Il contratto del client usa chiavi pubbliche X25519 raw32 in Base64, sale/nonce casuali e prova HMAC; la verifica della password e la derivazione delle chiavi avvengono esclusivamente nei client. Il relay impone l'ordine challenge → proof → accept e i ruoli, ma **non può stabilire se la prova sia crittograficamente valida**. L'host deve verificarla e richiedere conferma locale prima di inviare `accept`. Password in chiaro e chiavi private non devono entrare in nessun messaggio del protocollo.

Il viewer non può accettare una richiesta e un terzo dispositivo non può agire su una richiesta altrui. Una richiesta scade dopo 60 secondi dalla creazione, anche se challenge e proof sono state scambiate.

### Rifiuto, annullamento e scadenza

Host → relay: `{"type":"reject","requestId":"…"}`. Entrambi ricevono:

```json
{"type":"rejected","requestId":"…","hostId":"123456789","reason":"host-rejected"}
```

Viewer → relay: `{"type":"cancel","requestId":"…"}`. Entrambi ricevono `canceled` con gli stessi campi e `reason:"viewer-canceled"`.

Alla scadenza entrambi ricevono `expired` con `requestId`, `hostId` e `reason:"timeout"`. Alla perdita di uno dei socket, l'altro riceve `canceled` con `reason:"peer-disconnected"`. I messaggi successivi relativi a una richiesta terminata producono errore `unknown-request`.

### Sessione e dati

Host o viewer → relay:

```json
{"type":"data","sessionId":"…","payload":{"v":1,"seq":1,"data":"ciphertext-base64"}}
```

Altro partecipante ← relay:

```json
{"type":"data","sessionId":"…","peerId":"ID-mittente","payload":{"v":1,"seq":1,"data":"ciphertext-base64"}}
```

Il relay non legge il contenuto dell'envelope e richiede che `payload` sia un oggetto JSON. I client applicano crittografia autenticata, chiavi distinte per direzione e controllo delle sequenze; devono rifiutare envelope non validi, sessioni errate e replay. Un ID di sessione da solo non autorizza l'invio: il socket deve essere uno dei due partecipanti autenticati e approvati.

`{"type":"disconnect","sessionId":"…"}` termina la sessione. Entrambi ricevono `{"type":"disconnected","sessionId":"…","reason":"peer-requested"}`. La perdita di un socket genera `disconnected` con `reason:"peer-disconnected"`. Una nuova connessione non riprende automaticamente una vecchia sessione: richiede un'altra approvazione.

### Errori e limiti

Gli errori applicativi sono `{"type":"error","code":"…","message":"…","requestId":"…"}`; `requestId` è facoltativo. Codici principali: `not-registered`, `already-registered`, `auth-failed`, `invalid-name`, `host-unavailable`, `invalid-host`, `busy`, `rate-limited`, `unknown-request`, `forbidden`, `proof-required`, `invalid-challenge`, `invalid-proof`, `no-session`, `invalid-payload`, `payload-too-large`, `invalid-json`, `invalid-message`, `unknown-type`, `storage-unavailable`.

Default del relay:

- 256 KiB per messaggio JSON e frame, 128 frammenti per messaggio; frame binari non supportati.
- 1 MiB di buffer in uscita per socket; un destinatario lento viene chiuso con 1013 e la sessione termina.
- 256 connessioni totali, massimo 32 per indirizzo IP; 60 upgrade/minuto/IP.
- 30 tentativi registrazione/minuto/IP; 10 inviti/minuto/dispositivo e IP.
- Ping ogni 25 secondi; mancato pong al ping precedente provoca chiusura 1001.
- Più di 20 errori applicativi provocano chiusura 1008.

Il server gestisce masking client obbligatorio, frammentazione limitata, ping/pong intercalati, close handshake e verifica UTF-8. Rifiuta frame invalidi con 1002, UTF-8 invalido con 1007, messaggi troppo grandi con 1009, frame binari con 1003. Payload, password, token e chiavi non vengono registrati nei log dal relay.

## API per incorporamento e test

```js
import { createRelay } from './server/relay.mjs';
const relay = await createRelay({
  storePath: '/percorso/devices.json',
  allowedOrigins: ['https://remote.example.org'],
});
await relay.listen({ host: '127.0.0.1', port: 8787 });
console.log(relay.address());
await relay.close();
```

`createRelay` accetta anche `tls` (`{ cert, key }`), `pendingTimeoutMs`, `registerTimeoutMs`, `keepaliveMs`, `sweepIntervalMs`, `maxMessageBytes`, `maxBufferedBytes`, `maxConnections`, `maxConnectionsPerIp`, `registerLimit`, `inviteLimit`, `connectLimit`, `ratePeriodMs`. L'API espone inoltre `server`, l'istanza HTTP/HTTPS. I limiti numerici sono opzioni interne per integrazione/test; il processo CLI espone solo le variabili documentate sopra.
