# ADR-0007 — Reserva de stock atómica con `UPDATE` condicional + `SAVEPOINT`

**Estado:** Aceptada · **Fecha:** 2026-06-09 · **Ámbito:** `inventory-service`

## Contexto

Dos órdenes concurrentes piden el mismo SKU con stock justo. La implementación intuitiva es:

```python
product = session.query(Product).filter_by(sku=sku).one()
if product.available_quantity >= qty:          # ← lectura
    product.available_quantity -= qty          # ← escritura
```

Esto es un *check-then-act*: ambas transacciones leen `5`, ambas verifican que alcanza, ambas restan `3`. **El stock queda en -1.** El bug no aparece en tests secuenciales; aparece en producción bajo carga.

Además, una orden tiene varias líneas. Si la tercera línea no tiene stock, las dos primeras ya reservadas tienen que revertirse.

## Decisión

**La condición vive dentro del `UPDATE`**, no en el código Python:

```sql
UPDATE products
SET    available_quantity = available_quantity - :qty
WHERE  sku = :sku AND available_quantity >= :qty
```

PostgreSQL evalúa el `WHERE` con *row-level locking*: dos transacciones concurrentes sobre el mismo SKU **se serializan**. La segunda ve el valor ya decrementado. `rowcount == 0` significa stock insuficiente.

**`SAVEPOINT reserve_all`** envuelve todos los decrementos de una orden: *all-or-nothing*. Si una línea falla, ninguna queda reservada.

Todo esto ocurre dentro del Unit of Work compartido con el registro de idempotencia ([ADR-0006](0006-idempotencia-con-processed-events.md)).

## Consecuencias

**Positivas**

- Es **imposible** dejar stock negativo, sin locks explícitos ni retry optimista.
- Una sola query por línea; la base de datos hace el trabajo de serialización.
- El `SAVEPOINT` da atomicidad por orden sin abortar la transacción completa.

**Negativas / limitaciones**

- Acopla la corrección a la semántica de PostgreSQL. **SQLite no sirve** para verificar esto — de ahí [ADR-0008](0008-tests-contra-postgres-real.md).
- El resultado se comunica por `rowcount`, no por una excepción: el llamador tiene que interpretarlo explícitamente.
- SKUs muy demandados se convierten en un punto de contención: las transacciones se serializan sobre la misma fila.

## Alternativas

**Bloqueo optimista con versión de fila**: requiere reintentar en el código de aplicación y complica el caso multi-línea. **`SELECT ... FOR UPDATE` explícito**: funciona, pero son dos viajes a la base por línea cuando un solo `UPDATE` condicional da la misma garantía.
