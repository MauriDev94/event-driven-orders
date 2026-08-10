# ADR-0010 — Email del destinatario derivado del `customer_id`

**Estado:** Aceptada (MVP) · **Fecha:** 2026-06-09 · **Ámbito:** `notification-service`

## Contexto

Los *integration events* llevan `customer_id`, no una dirección de email. Es lo correcto desde el modelado: el email es un dato de identidad del cliente, y ese bounded context no existe en este sistema — no hay un customer-service que resuelva `customer_id → email`.

Sin ese servicio, `notification-service` no tiene de dónde sacar el destinatario.

## Decisión

El mapper deriva un placeholder **determinístico**: `{customer_id}@example.com`.

Los emails se envían a **Mailhog**, que los captura y los expone en su UI (`http://localhost:8025`) y su API (`/api/v2/messages`) sin entregar nada a un buzón real.

## Consecuencias

**Positivas**

- El flujo end-to-end es demostrable sin proveedor SMTP ni directorio de clientes.
- Al ser determinístico, los tests e2e pueden buscar el email por destinatario esperado.
- `example.com` está reservado por RFC 2606: aunque escapara un envío real, no llega a nadie.

**Negativas / limitaciones**

- **No sirve en producción real**: ningún cliente recibe nada.
- La dirección no es un dato de negocio, es una convención del código de mapeo.

*Customer directory service* está listado en *Mejoras futuras* del [README](../../README.md#mejoras-futuras-post-mvp).

## Alternativas

**Llevar el email dentro del evento.** Elimina el placeholder, pero acopla el contrato de integración a un dato que pertenece a otro bounded context: si el cliente cambia de email, los eventos ya publicados quedan con el valor viejo, y todo publicador de `OrderConfirmed` pasa a necesitar acceso a la identidad del cliente.
