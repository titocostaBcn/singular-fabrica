# Singular Wardrobe · Programa de fábrica

Gestión de producción de pedidos de Shopify (singularwardrobe.myshopify.com). Proyecto de Singular Wardrobe: NO mezclar con Manual Color (cuenta GitHub propia: titocosta@singularwardrobe.com).

## Flujo
1. Importación de Shopify (diaria 7:30 Madrid + botón "Importar"): pedidos abiertos sin enviar → `fab_pedidos` con estado `pendiente`.
2. Pantalla de fábrica (`web/index.html`), dos vistas:
   - Pedidos: urgentes (envío Exprés o etiqueta "urgente") primero y en rojo; luego del más antiguo al más nuevo.
   - Resumen producción: prendas por etapa agrupadas por modelo → talla (personalizadas una a una), selección por lotes, imprimir listado.
   Estados POR PRENDA: (pendiente) → cortar (vinilo) ⇄ sin_stock → estampar → empaquetar. Desde 9-oct las prendas ENTRAN DIRECTAMENTE en `cortar` (default de columna fab_lineas.estado); 'pendiente' queda solo para uso manual y su pestaña se oculta si está vacía. El pedido toma el de su prenda más atrasada (trigger BD).
3. Al empaquetar (botón "Empaquetado · etiqueta") → función `fab` pide etiqueta a GLS (servicio web SOAP `wsclientes.asmred.com/b2b.asmx`, método GrabaServicios, etiqueta PDF) → la pantalla la imprime → check `etiqueta_impresa`.
4. Si `fab_config.shopify_crear_envio = si` y GLS en modo real → `fulfillmentCreate` en Shopify con tracking GLS y aviso al cliente.
5. Pedidos sin dirección = recogida en taller: no generan etiqueta.

## Piezas
- Supabase proyecto `hgvsrmywsfnmvenkfynb`. Tablas `fab_pedidos`, `fab_lineas`, `fab_eventos` (log), `fab_config` (ajustes). Bucket privado `fab-etiquetas`.
- Edge function `supabase/functions/fab/index.ts` (verify_jwt=false, auth propia: JWT de usuario o cabecera `x-fab-cron` = vault `fab_cron_key`). Acciones: importar, lineas, producido, impresa, reimprimir, diag, prueba_gls. Desplegada v4. La función también exige que el email esté en `fab_usuarios`.
- Credenciales Shopify: app con client_credentials, secretos en vault (`shopify_shop`, `shopify_client_id`, `shopify_client_secret`) leídos con `public.read_secret` (solo service_role).
- GLS: modo `pruebas` usa el UID público de pruebas; modo `real` usa vault `gls_uid_cliente`.
- Demo sin conexión: abrir `web/index.html?demo`.

## Reglas
- Commits: autor `titocostaBcn <300454408+titocostaBcn@users.noreply.github.com>` y SIN trailer Co-Authored-By. Netlify (plan gratis, repo privado) bloquea despliegues de autores/coautores no reconocidos.
- Diagnóstico antes de actuar; autorización explícita de Tito antes de escribir en Supabase o Shopify.
- Probar con un pedido antes de activar nada para todos.

## Pendiente (9-oct-2026)
- [x] Migración 02 (estados por prenda) + función v4 — aplicadas 9-oct.
- [x] Migración 03 — aplicada 9-oct: RLS solo emails de `fab_usuarios`, cron `fab_importar_0730`, usuario titocosta@singularwardrobe.com.
- [ ] Usuarios para el personal de fábrica (alta en Auth + fila en `fab_usuarios`).
- [ ] Ojo: este Supabase también aloja cosas de TDP (schema `tdp_deposito`, usuarios @tdpdecoracion.es). Tito quiere separar empresas.
- [ ] UID cliente GLS y servicio/horario contratados (provisional 96/18 nacional, 74/3 internacional).
- [ ] Permisos app Shopify: read/write_merchant_managed_fulfillment_orders (hoy solo lectura).
- [ ] Impresora de etiquetas (térmica 10x15 o A4) y Chrome con --kiosk-printing en el PC de fábrica.
- [ ] Remitente de la etiqueta: hoy "Carrer de Bosch i Gimpera 20, Nave Manual Color" (confirmar si mostrar Manual Color).
- [x] Repo GitHub: titocostaBcn/singular-fabrica (privado; cuenta de Singular).
- [x] Netlify: proyecto `tallersingular` → https://tallersingular.netlify.app (se publica solo al subir a main).
