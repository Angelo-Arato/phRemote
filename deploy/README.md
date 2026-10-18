# Pubblicare il relay phRemote su Internet

Sono disponibili il Blueprint Render [render.yaml](../render.yaml) e una configurazione Docker per un server proprio. Entrambe mantengono una sola istanza relay con identità persistenti.

La configurazione Docker prepara il relay dietro Caddy 2, che ottiene e rinnova il certificato TLS del dominio. Il container relay usa Node 24 Alpine con utente `node`, database persistente e filesystem dell'immagine in sola lettura. La porta 8787 rimane nella rete privata Docker; all'esterno Caddy pubblica HTTP/HTTPS.

I file sono una configurazione pronta da rivedere. La loro creazione non pubblica servizi e non modifica il server remoto.

## Render: relay Node con disco persistente

Il [Blueprint](../render.yaml) definisce un Web Service nativo Node 24 a Francoforte, piano `0.5c-512mb`, una sola istanza e disco persistente da 1 GB. Sono **risorse a pagamento**: controlla il preventivo corrente mostrato da Render prima di confermare la creazione. Il piano Free non mantiene questo disco e non è la configurazione prevista per conservare le identità. [Riferimento Blueprint](https://render.com/docs/blueprint-spec), [dischi persistenti](https://render.com/docs/disks).

Il build esegue solo `node --check server/index.mjs`; il relay non richiede pacchetti npm, Electron o il componente nativo macOS. Lo start esegue `node server/index.mjs`, con ascolto su `0.0.0.0:10000` e controllo salute `/health`. Gli ID vengono conservati in `/var/data/phremote/devices.json`, dentro il disco montato a `/var/data/phremote`.

Per predisporre la pubblicazione dal tuo account:

1. Salva il progetto con `render.yaml` nella radice del repository Git che vuoi collegare a Render.
2. Nel dashboard Render scegli **New → Blueprint**, collega quel repository e seleziona il relativo branch. Il Blueprint usa automaticamente il repository che lo contiene; non richiede un URL Git codificato nel file.
3. Controlla nella schermata di revisione servizio, regione, piano e disco prima di **Deploy Blueprint**. La conferma crea risorse fatturabili. [Procedura ufficiale](https://render.com/docs/infrastructure-as-code).
4. Dopo l'avvio, usa il nome pubblico effettivamente assegnato da Render: `https://NOME-EFFETTIVO.onrender.com/health` deve rispondere `{"ok":true,"protocolVersion":1}`. Nei client imposta `wss://NOME-EFFETTIVO.onrender.com/ws`.

Render gestisce automaticamente TLS e l'upgrade WebSocket: su questa piattaforma non occorre avviare Caddy né impostare `PHREMOTE_TLS_CERT` o `PHREMOTE_TLS_KEY`. Un dominio personalizzato è facoltativo. I client nativi possono mantenere `PHREMOTE_ALLOWED_ORIGINS` vuota; un eventuale client browser richiede le proprie origini precise nella allowlist. [Web Services](https://render.com/docs/web-services), [WebSocket su Render](https://render.com/docs/websocket).

Il Blueprint disabilita i deploy automatici del servizio con `autoDeployTrigger: "off"`; gli aggiornamenti del codice si possono avviare con **Manual Deploy**. La sincronizzazione del Blueprint è una funzione separata: per controllarla manualmente imposta **Auto Sync → No** nelle impostazioni del Blueprint. [Sincronizzazione Blueprint](https://render.com/docs/infrastructure-as-code#disabling-automatic-sync).

Mantieni `numInstances: 1` e l'autoscaling disattivato. Presenza, pairing e sessioni sono in memoria; un restart o un deploy interrompe i collegamenti e richiede una nuova connessione e approvazione host. Le identità e i token già conservati continuano a funzionare grazie al disco, mentre trasferire client da un altro relay richiede migrare anche il suo database. Il disco persistente comporta una breve indisponibilità durante i deploy. Per il backup del JSON puoi usare il trasferimento SCP documentato da Render e conservarne una copia protetta fuori dalla piattaforma. [Limiti e trasferimento file dei dischi](https://render.com/docs/disks).

La configurazione è preparata localmente: nessun servizio Render, repository remoto o abbonamento viene creato da questi file.

## Requisiti del server

- Docker Engine e plugin Docker Compose disponibili sul server Linux.
- Un dominio dedicato, ad esempio `remote.example.com`, con record DNS **A** verso l'IPv4 pubblica del server. Se esiste un record **AAAA**, anche l'IPv6 deve raggiungere lo stesso servizio.
- Porte in ingresso **80/TCP** e **443/TCP** libere e raggiungibili da Internet, compresi firewall del provider ed eventuale inoltro NAT. **443/UDP** è facoltativa e consente HTTP/3.
- Accesso in uscita del container Caddy a DNS e alle autorità ACME per ottenere/rinnovare il certificato.

Non aprire la porta 8787 sul firewall e non pubblicarla con altre configurazioni Docker. Il collegamento client deve usare `wss://remote.example.com/ws`.

## Configurazione e avvio

Copia il progetto sul server, poi dalla sua radice:

```sh
cd deploy
cp .env.example .env
```

Modifica `.env` e sostituisci `remote.example.com` con il dominio reale:

```dotenv
PHREMOTE_DOMAIN=remote.example.com
PHREMOTE_ALLOWED_ORIGINS=
```

Per i client desktop nativi l'allowlist può rimanere vuota. Per un client browser inserisci le origini complete e precise, ad esempio `https://app.example.com`, separate da virgole. Il dominio deve contenere solo il nome DNS, senza schema, percorso o porta.

Convalida la configurazione senza avviare servizi:

```sh
docker compose --env-file .env config --quiet
```

Quando vuoi pubblicare il servizio sul server:

```sh
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=50 relay caddy
```

Caddy parte dopo che il controllo `/health` del relay è riuscito. Al primo avvio il rilascio del certificato può richiedere qualche istante. Verifica HTTPS dall'esterno:

```sh
curl --fail https://remote.example.com/health
```

Risposta attesa: `{"ok":true,"protocolVersion":1}`. Configura quindi nei client il relay `wss://remote.example.com/ws`. Gli ID e i token già creati su un altro relay non vengono trasferiti automaticamente: appartengono al suo database.

`reverse_proxy` di Caddy gestisce direttamente l'upgrade WebSocket; `/ws` e `/health` vengono inoltrati al relay e gli altri percorsi rispondono 404. Le identità usano il volume `phremote_relay_data`; i certificati e lo stato di Caddy usano `phremote_caddy_data` e `phremote_caddy_config`. Il nome progetto è fissato in Compose per mantenere stabili questi nomi.

## Backup e ripristino delle identità

Esegui i comandi seguenti dalla directory `deploy`. Per una copia coerente, arresta brevemente il relay:

```sh
mkdir -p backups
chmod 700 backups
docker compose --env-file .env stop relay
docker compose --env-file .env cp relay:/var/lib/phremote/devices.json backups/devices.json
chmod 600 backups/devices.json
docker compose --env-file .env start relay
```

Il file viene creato dopo la prima registrazione di un dispositivo. Conserva una copia del backup anche fuori dal server. Contiene ID, nomi e hash dei token; i client conservano separatamente i propri token originali. Proteggi anche i backup dei volumi Caddy, che contengono chiavi private TLS.

Per ripristinare `backups/devices.json`, arresta il relay e scrivi il file nel volume con lo stesso utente non privilegiato del servizio:

```sh
docker compose --env-file .env stop relay
docker compose --env-file .env run --rm --no-deps -T relay \
  node --input-type=module -e '
    import { writeFile } from "node:fs/promises";
    let source = "";
    for await (const chunk of process.stdin) source += chunk;
    const data = JSON.parse(source);
    if (data.version !== 1 || !Array.isArray(data.devices)) throw new Error("Backup non valido");
    await writeFile(process.env.PHREMOTE_STORE, source, { mode: 0o600 });
  ' < backups/devices.json
docker compose --env-file .env start relay
```

Il comando di ripristino sostituisce le identità correnti: i dispositivi creati dopo il backup dovranno registrarsi nuovamente. Non usare `docker compose down -v` per una normale manutenzione, perché rimuove i volumi e i relativi dati.

## Aggiornamento e limiti operativi

Una volta aggiornati i file del progetto sul server:

```sh
docker compose --env-file .env build --pull relay
docker compose --env-file .env pull caddy
docker compose --env-file .env up -d
```

Un riavvio interrompe le sessioni; i dispositivi possono riconnettersi usando i token già conservati, e ogni nuova sessione richiede approvazione. Mantieni **una sola istanza relay** per database: non usare `--scale relay=...` e non condividere il volume fra processi diversi. Stato di presenza, richieste pendenti e sessioni sono in memoria.

Il relay vede l'indirizzo interno di Caddy, quindi i suoi limiti per IP si applicano complessivamente ai client dietro questo proxy. Non è presente un access log di Caddy e il relay non registra token, password o payload. La documentazione del [protocollo relay](../server/README.md) descrive limiti e API.

Le immagini usano i tag ufficiali `node:24-alpine` e `caddy:2-alpine`; i tag ricevono aggiornamenti. Per una distribuzione con versioni riproducibili puoi fissare i digest dopo aver verificato le immagini sul server.

Riferimenti ufficiali: [Caddy reverse proxy e WebSocket](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [Docker Compose e variabili d'ambiente](https://docs.docker.com/compose/how-tos/environment-variables/envvars-precedence/), [immagine ufficiale Node](https://hub.docker.com/_/node).
