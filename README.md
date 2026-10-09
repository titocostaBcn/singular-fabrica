# Singular Wardrobe · Producción

Pedidos de Shopify → pantalla de fábrica → etiqueta GLS → Shopify enviado.

- `web/index.html` — pantalla de fábrica (web estática, publicable en GitHub Pages).
- `supabase/functions/fab/` — función con toda la lógica (importar, estados, GLS, Shopify).
- Base de datos: tablas `fab_*` en Supabase (proyecto hgvsrmywsfnmvenkfynb).

Estados: pendiente → espera_stock → producido (+ check etiqueta impresa).
Configuración en la tabla `fab_config` (modo GLS pruebas/real, servicio, remitente, etc.).
