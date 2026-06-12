# Deploy — Event-Driven Orders

Guía paso a paso para desplegar el stack completo en una VM Linux usando
**Docker Compose + Caddy**, pensada para **Oracle Cloud Always Free** (ARM
Ampere, Ubuntu) pero aplicable a cualquier VM con Docker.

> Esta guía es para un **deploy de portfolio/demo**: Mailhog se queda como
> "buzón" visible (no se manda email real), y el objetivo es que un
> reclutador pueda hacer un `POST /v1/orders` y ver el resultado en
> Swagger + el email capturado en Mailhog.

## 0. Resumen de la arquitectura de deploy

```
Internet
   │  :80 / :443
   ▼
┌────────┐   order-service:8000   (Swagger /docs, /v1/orders)
│ Caddy  │──────────────────────▶ inventory-service (interno, sin exponer)
│ (TLS)  │   rabbitmq:15672 (Management UI, basic auth)
│        │──────────────────────▶ notification-service (interno, sin exponer)
│        │   mailhog:8025 (UI, basic auth)
└────────┘
   │
   └── red interna edo_net: postgres-orders / postgres-inventory (NUNCA expuestos)
```

- **Único punto de entrada**: Caddy, en 80/443, con HTTPS automático (Let's Encrypt).
- **Expuesto vía Caddy**: `order-service` (API + `/docs`), RabbitMQ Management UI
  y Mailhog UI — las dos últimas con **basic auth**.
- **Nunca expuesto**: Postgres (orders/inventory), AMQP 5672 directo, SMTP 1025.

---

## 1. Crear la VM en Oracle Cloud (Always Free)

1. Entrar a [Oracle Cloud Console](https://cloud.oracle.com/) → **Compute → Instances → Create Instance**.
2. **Image**: Ubuntu (24.04 LTS o la última disponible).
3. **Shape**: cambiar a **Ampere (ARM)** → `VM.Standard.A1.Flex` → asignar, por ejemplo, **4 OCPUs / 24 GB RAM** (dentro del tier Always Free).
4. **Networking**: usar la VCN default, asegurarse de que la instancia tenga **IP pública**.
5. **Add SSH keys**: pegar tu clave pública (o generar un par nuevo y descargar la privada).
6. Crear la instancia y anotar la **IP pública**.

### 1.1 Reglas de firewall (Security List / NSG)

En la VCN de la instancia → **Security Lists** (o Network Security Group) → agregar **Ingress Rules**:

| Puerto | Protocolo | Origen | Motivo |
|---|---|---|---|
| 22 | TCP | tu IP (o `0.0.0.0/0` si no tenés IP fija) | SSH |
| 80 | TCP | `0.0.0.0/0` | HTTP (Caddy, challenge de Let's Encrypt) |
| 443 | TCP | `0.0.0.0/0` | HTTPS (Caddy) |

**NO abrir**: 5432/5433/5434 (Postgres), 5672 (AMQP), 15672/8025/1025 directos —
todo eso entra por Caddy (15672/8025 vía subdominio) o queda solo en `edo_net`.

> Ubuntu además trae `iptables`/`netfilter` propio además de la Security List
> de Oracle. Si después de abrir el puerto en la consola seguís sin acceso,
> revisar `sudo iptables -L` y, si hace falta, agregar reglas equivalentes con
> `sudo netfilter-persistent` o usar `sudo ufw allow 80,443/tcp` (si `ufw` está activo).

---

## 2. Conectarse por SSH e instalar Docker

```bash
ssh -i /ruta/a/tu_clave.pem ubuntu@<IP_PUBLICA>
```

Instalar Docker Engine + el plugin `docker compose` (repo oficial de Docker):

```bash
# Dependencias
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Repo oficial de Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Permite correr docker sin sudo (cerrar y volver a abrir la sesión SSH después)
sudo usermod -aG docker $USER
```

Verificar versión (necesitamos **Compose >= 2.24** para que
`docker-compose.prod.yml` funcione correctamente — usa `!reset` para limpiar
los `ports` heredados del compose de dev):

```bash
docker compose version
```

---

## 3. Clonar el repo y configurar variables

```bash
git clone https://github.com/MauriDev94/event-driven-orders.git
cd event-driven-orders

cp deploy/env.production.example .env.production
nano .env.production   # completar todos los CHANGE_ME
```

Completar en `.env.production`:

- **`DOMAIN`**: ver sección 4 (dominio).
- **`RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS`**: credenciales del broker.
  Reflejarlas también en `RABBITMQ_URL` (mismo user/pass).
- **`RABBITMQ_UI_USER` / `RABBITMQ_UI_PASSWORD_HASH`** y
  **`MAILHOG_UI_USER` / `MAILHOG_UI_PASSWORD_HASH`**: basic auth de Caddy.
  Generar el hash con:

  ```bash
  docker run --rm caddy:2-alpine caddy hash-password --plaintext 'tu-password-fuerte'
  ```

  El comando imprime algo como `$2a$14$abcdefg...`. En `.env.production` cada
  `$` se escribe duplicado (`$$`) porque Docker Compose interpola `$` como
  variable — ej: `$2a$14$abc` → `$$2a$$14$$abc`.

- **`ORDERS_DB_*` / `INVENTORY_DB_*`**: passwords fuertes para cada Postgres.
- **`SMTP_*`**: dejar los valores por defecto (Mailhog interno).

---

## 4. Configurar el dominio

Opción más simple — **sslip.io** (gratis, sin registrar nada):

```
DOMAIN=<IP-con-guiones>.sslip.io
```

Ej: si la IP pública de la VM es `203.0.113.10`:

```
DOMAIN=203-0-113-10.sslip.io
```

`sslip.io` resuelve automáticamente tanto `203-0-113-10.sslip.io` como
cualquier subdominio (`rabbitmq.203-0-113-10.sslip.io`,
`mailhog.203-0-113-10.sslip.io`) a esa IP — Caddy puede emitir certificados
Let's Encrypt para los tres sin configuración de DNS adicional.

Alternativas:

- **DuckDNS** (gratis, subdominio propio tipo `tu-nombre.duckdns.org` +
  wildcard `*.tu-nombre.duckdns.org` apuntando a la IP).
- **Dominio propio**: crear un registro `A` (y un `A`/`CNAME` wildcard
  `*.tudominio.com` o registros individuales para `rabbitmq.` y `mailhog.`)
  apuntando a la IP pública de la VM.

---

## 5. Levantar el stack

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production up -d --build
```

La primera vez tarda varios minutos (build de las 3 imágenes + pull de
Postgres/RabbitMQ/Mailhog/Caddy + emisión de certificados TLS).

### 5.1 Verificar healthchecks

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production ps
```

Todos los servicios deben quedar `healthy` (Postgres/RabbitMQ tardan ~1-2 min
por los `start_period` de sus healthchecks). Ver logs si algo no levanta:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production logs -f
```

### 5.2 Probar el flujo end-to-end

1. Abrir `https://<DOMAIN>/docs` → Swagger de `order-service`.
2. Crear una orden con stock suficiente (`SKU-001`, ver catálogo seed en el
   [README](README.md#catálogo-seed-inventory-service)):

   ```bash
   curl -X POST https://<DOMAIN>/v1/orders \
     -H "Content-Type: application/json" \
     -d '{"customer_id": "c-1", "lines": [{"product_id": "SKU-001", "quantity": 1, "unit_price": "10.00"}]}'
   ```

3. Esperar unos segundos y consultar `GET /v1/orders/<order_id>` → `status: "confirmed"`.
4. Abrir `https://mailhog.<DOMAIN>` (pide el basic auth configurado) y verificar
   que llegó el email de confirmación a `c-1@example.com`.
5. (Opcional) `https://rabbitmq.<DOMAIN>` → Management UI, también con basic auth.

---

## 6. Troubleshooting

### Servicios tardan mucho / quedan `starting` mucho tiempo

En VMs con disco de red lento (común en tiers free de IaaS), Postgres y
RabbitMQ pueden tardar más que los `start_period` definidos
(`postgres-*`: 90s, `rabbitmq`: 120s). Si `docker compose ps` muestra
`(health: starting)` por más de 3-4 minutos:

```bash
# Ver el progreso real del arranque del contenedor lento
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production logs postgres-orders rabbitmq
```

Si el contenedor está claramente inicializando (ej. RabbitMQ todavía
"Starting broker..."), esperar — no reiniciar. Si el `start_period` no alcanza
en tu VM de forma consistente, se puede aumentar en `docker-compose.yml`
(`start_period: 180s` para Postgres, `start_period: 240s` para RabbitMQ) —
afecta solo cuánto tarda Docker en empezar a contar `retries` fallidos, no el
comportamiento de la app.

### Caddy no obtiene certificado HTTPS

- Confirmar que el puerto 80 está abierto (Let's Encrypt usa el challenge HTTP-01
  sobre el puerto 80, incluso para emitir certificados HTTPS).
- Confirmar que `DOMAIN` resuelve a la IP pública de la VM:
  `dig +short <DOMAIN>` (o `nslookup`) desde tu máquina.
- Ver logs de Caddy: `docker compose ... logs caddy` — busca errores de ACME.

### `order-service` no conecta a Postgres / RabbitMQ al arrancar

Gracias a la Fase 8a, los 3 servicios reintentan la conexión al broker con
backoff (hasta 5 intentos al arranque, luego un watchdog en background
indefinido) y reportan el estado en `/health` (`"broker": "unhealthy"` mientras
no hay conexión). No hace falta reiniciar el contenedor — esperar a que
RabbitMQ termine de levantar y los logs mostrarán
`"connected to broker after N attempt(s)"`.

### Ver logs filtrados por correlation ID

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production \
  logs order-service inventory-service notification-service --no-color \
  | grep -o '{.*}' | jq -c 'select(.correlation_id == "<id>")'
```

### Re-deploy tras cambios en el repo

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production up -d --build
```

O usar el script [`deploy/deploy.sh`](deploy/deploy.sh) (hace lo mismo, idempotente).

---

## 7. Lo que falta hacer manualmente en la VM (Fase 8c)

- Crear la VM real y aplicar esta guía paso a paso.
- Generar los hashes de basic auth y completar `.env.production` con secrets reales.
- Elegir y configurar el dominio (`sslip.io` recomendado para arrancar).
- Verificar el flujo end-to-end contra la URL pública.
- (Opcional) configurar backups del volumen de Postgres, rotación de logs de Docker.
