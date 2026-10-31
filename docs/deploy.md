# Guía de deploy

Cómo publicar el stack en una VM gratis de Oracle Cloud (Always Free, ARM) con `docker-compose.prod.yml` y Caddy. Todo es gratis de crear y de mantener: la cuenta se queda en el plan Always Free, sin pasar a Pay As You Go, así que Oracle no puede cobrar nada.

Esta guía no tiene IPs ni contraseñas reales. Donde dice `<ip>`, `<vm>` o `<DOMAIN>`, va el valor de tu VM.

## Qué queda publicado

| URL | Qué es | Acceso |
|---|---|---|
| `https://<DOMAIN>` | API de `order-service` y Swagger (`/docs`) | Público |
| `https://mailpit.<DOMAIN>` | Mailpit: los emails que envía `notification-service` (no se entregan a nadie) | Basic auth de Caddy |
| `https://grafana.<DOMAIN>` | Grafana con el dashboard del proyecto | Basic auth de Caddy, y después el login de Grafana |
| UI de RabbitMQ | Colas, DLQ y mensajes | Solo por túnel SSH (paso 6) |

Nada más escucha desde internet: Postgres, AMQP, Prometheus y los servicios quedan en la red interna de Docker. Caddy es el único contenedor con puertos públicos (80 y 443) y saca los certificados HTTPS de Let's Encrypt solo.

## 1. Crear la VM

En la consola de Oracle, **Compute → Instances → Create instance**:

- **Imagen:** Canonical Ubuntu LTS (24.04 o 26.04), versión aarch64.
- **Shape:** `VM.Standard.A1.Flex` (Ampere, ARM), con 1 OCPU y 4 GB de memoria. Alcanza para el stack actual, que en reposo usa ~0,8 GB (medido en el [paso 0 del roadmap](roadmap.md)).
- **Red:** una VCN con subred pública, con IPv4 pública asignada.
- **SSH:** sube tu clave pública. El usuario de las imágenes Ubuntu es `ubuntu`.

Antes de elegir el tamaño, ten en cuenta:

- **Oracle reclama las VMs gratis que parecen ociosas.** Lo hace si en 7 días quedan los tres bajo el 20 %: el CPU (percentil 95), la red y la memoria. Con 4 GB, la memoria del stack en reposo queda sobre ese umbral; con 12 GB, no. Confírmalo con la métrica de memoria de la VM durante la primera semana.
- **El plan gratis de Ampere A1** es de 2 OCPU y 12 GB en total por cuenta (hasta 2026 eran 4 y 24). Si la suma de tus VMs A1 lo supera, Oracle deshabilita todas, no solo la que sobra.
- **"Out of host capacity"** es común al crear una VM A1. Reintenta más tarde, prueba otro availability domain o pide menos OCPU y memoria. La región principal se elige al registrarse y no se puede cambiar.

## 2. Abrir los puertos 80 y 443

En la **Security List** de la subred pública (Networking → Virtual cloud networks → tu VCN), agrega dos reglas de ingreso: TCP, origen `0.0.0.0/0`, puertos `80` y `443`. Por defecto solo está abierto el 22 (SSH). Let's Encrypt necesita el 80 para validar el dominio, y Caddy lo redirige a HTTPS.

**En la VM no hay que tocar iptables.** Las imágenes Ubuntu de Oracle traen reglas que rechazan todo lo que no sea SSH (`REJECT` al final de `INPUT` y de `FORWARD`). Aun así, el tráfico hacia un puerto que publica Docker pasa por `FORWARD`, y Docker pone sus propias reglas antes de ese `REJECT`. Se verificó aplicando esas reglas a un host con Docker: el puerto publicado por un contenedor respondía, y un servicio escuchando directo en el host quedaba bloqueado.

Si después tocas iptables por otro motivo, no corras `netfilter-persistent save` ni `reload` con Docker andando. `save` guarda también las reglas que Docker crea al arrancar, y `reload` las borra; si pasa, `sudo systemctl restart docker` las vuelve a crear.

## 3. Instalar Docker

Conéctate con `ssh ubuntu@<ip>` e instala Docker Engine desde el repositorio oficial ([guía de Docker para Ubuntu](https://docs.docker.com/engine/install/ubuntu/)):

```bash
# Clave GPG de Docker
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Repositorio
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update

sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu   # docker sin sudo; vale desde la próxima sesión SSH
```

Sal y vuelve a entrar por SSH, y revisa que `docker compose version` sea 2.24.4 o más nuevo. Las versiones más viejas ignoran `!reset` y `!override` de `docker-compose.prod.yml` sin avisar, y dejarían publicados los puertos del compose de desarrollo.

## 4. Clonar y configurar

```bash
git clone https://github.com/MauriDev94/event-driven-orders.git
cd event-driven-orders
python3 scripts/generate_env.py --template deploy/env.production.example --output .env.production
```

El script llena cada contraseña vacía (RabbitMQ, las dos bases, Grafana) con un valor aleatorio y nunca sobrescribe un `.env.production` que ya exista. `.env.production` no se versiona.

Quedan dos cosas por completar a mano.

**El dominio.** Edita `DOMAIN` en `.env.production`. Hay dos opciones gratis, y las dos resuelven también `mailpit.<DOMAIN>` y `grafana.<DOMAIN>`:

- **sslip.io**, sin registrarte: `DOMAIN=<ip-con-guiones>.sslip.io` (si la IP es `203.0.113.10`, `203-0-113-10.sslip.io`). Let's Encrypt cuenta los certificados de todos los usuarios de sslip.io contra un mismo límite (sslip.io no está en la [Public Suffix List](https://publicsuffix.org/)). Les subió ese límite a 250 000 por semana, pero si Caddy no logra sacar un certificado por límite de emisión, usa DuckDNS.
- **DuckDNS** (cuenta gratis): creas `<nombre>.duckdns.org` apuntando a la IP de la VM, y `DOMAIN=<nombre>.duckdns.org`. Está en la Public Suffix List, así que el límite de Let's Encrypt (50 certificados por semana) es solo tuyo.

Con cualquiera de los dos, si la IP de la VM cambia, cambia también `DOMAIN` (sslip.io) o el registro de DuckDNS.

**Las contraseñas de basic auth** de Mailpit y Grafana. Caddy guarda solo el hash bcrypt, y Compose interpreta cada `$` como el comienzo de una variable, así que cada `$` del hash va duplicado. Esto genera una contraseña aleatoria por cada una, escribe su hash ya escapado en `.env.production` y te muestra la contraseña para que la guardes en tu gestor de contraseñas:

```bash
set_hash() {  # set_hash <VARIABLE>: contraseña aleatoria y su hash bcrypt, con cada "$" duplicado
  local pw hash
  pw="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  hash="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$pw" | sed 's/\$/$$/g')"
  sed -i "s|^$1=.*|$1=$hash|" .env.production
  echo "$1: contraseña $pw"
}
set_hash MAILPIT_UI_PASSWORD_HASH
set_hash GRAFANA_UI_PASSWORD_HASH
```

El usuario de las dos es `admin` (`MAILPIT_UI_USER` y `GRAFANA_UI_USER`).

## 5. Levantar el stack

Un alias para no repetir los tres archivos en cada comando:

```bash
echo "alias edo='docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production'" >> ~/.bashrc
source ~/.bashrc

edo up -d --build   # la primera vez construye las 3 imágenes en la VM y tarda varios minutos
edo ps              # todos "Up"; los que tienen healthcheck, "(healthy)"
```

Comprueba desde tu máquina:

```bash
curl https://<DOMAIN>/health   # {"status":"ok",...,"database":"healthy","broker":"healthy"}
```

Si el certificado todavía no está, Caddy lo está pidiendo: `edo logs caddy` muestra `certificate obtained successfully` por cada dominio cuando termina.

## 6. Entrar a las UIs

- **Grafana:** `https://grafana.<DOMAIN>`. Primero pide el basic auth de Caddy (`admin` y la contraseña de `set_hash GRAFANA_UI_PASSWORD_HASH`). Después viene el login de Grafana, con `admin` y la contraseña generada en `.env.production`: `grep '^GRAFANA_ADMIN_PASSWORD=' .env.production | cut -d= -f2-`. Caddy no le reenvía su header `Authorization` a Grafana: Grafana lo tomaría como un intento de login fallido de `admin` y, a las pocas requests, lo bloquearía.
- **Mailpit:** `https://mailpit.<DOMAIN>`, con `admin` y la contraseña de `set_hash MAILPIT_UI_PASSWORD_HASH`.
- **RabbitMQ:** no se publica en internet. El override la deja en `127.0.0.1:15672` de la VM. Desde tu máquina, abre un túnel y entra a <http://localhost:15672>:

  ```bash
  ssh -L 15672:127.0.0.1:15672 ubuntu@<ip>
  ```

  El usuario y la contraseña son `RABBITMQ_DEFAULT_USER` y `RABBITMQ_DEFAULT_PASS` de `.env.production`. No va detrás de Caddy porque su JavaScript manda su propio header `Authorization` en cada llamada a la API, y el basic auth de Caddy lo rechazaría.

## 7. Actualizar

Desde la raíz del repo, en la VM:

```bash
./deploy/deploy.sh   # git pull --ff-only, edo up -d --build y edo ps
```

Las migraciones de Alembic corren solas al arrancar cada servicio ([ADR-0016](adr/0016-migraciones-alembic-al-arrancar.md)).

## Operación

- **Logs:** `edo logs -f order-service` (o cualquier servicio). Son JSON con `correlation_id`, así que un pedido se sigue entre servicios con `edo logs | grep <correlation_id>`.
- **Reinicios:** todos los servicios tienen `restart: always`, y el paquete de Docker deja el daemon habilitado al arrancar la VM, así que el stack vuelve solo después de un reinicio.
- **Cambiar una contraseña de Postgres, de Grafana o de RabbitMQ:** los tres guardan la contraseña con la que se creó su volumen. Cambiarla en `.env.production` no alcanza; regenerar todo exige `edo down -v`, que borra los pedidos, el stock, los mensajes pendientes y la configuración de Grafana. Las de basic auth sí se cambian con `set_hash` y `edo up -d caddy`.
- **Cambiar los argumentos de una cola:** las colas viven en el volumen de RabbitMQ, que no acepta redeclarar una cola existente con otros argumentos. Si un deploy cambia una en `app/core/messaging/topology.py`, el servicio arranca sin consumir y lo registra en su log. Hay que borrar la cola, con lo que se pierden sus mensajes pendientes, y reiniciar el servicio para que la cree de nuevo: `edo exec rabbitmq rabbitmqctl delete_queue <cola>` y `edo restart <servicio>`.
- **Memoria:** `docker stats --no-stream` muestra el uso por contenedor. Revisa en la consola de Oracle que la memoria de la VM quede sobre el 20 % (paso 1).

## Limitaciones conocidas

- **Los emails no se entregan.** Mailpit los captura para mostrarlos; no hay un servidor SMTP real.
- **La deduplicación de `notification-service` vive en memoria** ([ADR-0009](adr/0009-notification-service-sin-base-de-datos.md)): un reinicio la pierde, y un evento reentregado justo después podría mandar el email dos veces.

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| `curl https://<DOMAIN>` se queda esperando hasta el timeout | Faltan las reglas de 80 y 443 en la Security List (paso 2) |
| `Connection refused` en 80 o 443 | Caddy no está corriendo: `edo ps` y `edo logs caddy` |
| Caddy se reinicia en loop con `username and password cannot be empty or missing` | Falta un `*_UI_PASSWORD_HASH` en `.env.production` (paso 4) |
| `edo` avisa `The "…" variable is not set. Defaulting to a blank string.` con un nombre raro | Un hash se pegó sin duplicar los `$`: Compose lo corrompe y el basic auth rechaza siempre la contraseña. Vuelve a correr `set_hash` |
| Caddy no logra el certificado | El dominio no resuelve a la IP de la VM, el puerto 80 está cerrado o se alcanzó el límite de Let's Encrypt (paso 4): `edo logs caddy` dice cuál |
| Un servicio no se conecta a su Postgres o a RabbitMQ después de regenerar `.env.production` | El volumen tiene la contraseña anterior (ver Operación) |
| Un servicio no consume después de un deploy y su log dice `PRECONDITION_FAILED - inequivalent arg` | El deploy cambió los argumentos de una cola que ya existe (ver Operación) |
