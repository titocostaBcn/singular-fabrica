# Singular Wardrobe · Programa de fábrica

Gestión de producción de pedidos de Shopify (singularwardrobe.myshopify.com). Proyecto de Singular Wardrobe: NO mezclar con Manual Color (cuenta GitHub propia: titocosta@singularwardrobe.com).

## Flujo
1. Importación de Shopify (diaria 8:00 Madrid, cron `fab_importar_0800` `0 6,7 * * *` UTC + `?hora=8`; + botón "Importar"): pedidos abiertos sin enviar → `fab_pedidos`. Si falla se registra `importacion_error` en `fab_eventos`; desde las 8:15 la pantalla muestra en rojo "ERROR: no actualizado hoy" si no hay `importacion` correcta del día.
2. Pantalla de fábrica (`web/index.html`), dos vistas:
   - Pedidos: urgentes (envío Exprés o etiqueta "urgente") primero y en rojo; luego del más antiguo al más nuevo.
   - Resumen producción: prendas por etapa agrupadas por modelo → variante (personalizadas una línea por unidad), imprimir listado y exportar Excel (ExcelJS).
     En Cortar vinilo: genéricas = CONTADOR de vinilos cortados (tabla `fab_cortados`, rpc `fab_sumar_cortados`), NO mueve pedidos; los pedidos genéricos se pasan a mano y al pasar de cortar→estampar consumen del contador (trigger). Personalizadas: "✔ Hecha" mueve esa prenda/pedido a Estampar.
   Asignación automática (migración 09, APLICADA 9-oct; el MCP cancela SQL con DELETE/DROP): `fab_autoasignar()` reparte el contador de cortadas a pedidos (urgentes y luego antiguos) SOLO si el pedido queda completo (resto de estándar cubierto, personalizadas en Empaquetar, nada en pendiente/sin_stock); mueve las prendas a empaquetar (trigger descuenta contador). Se lanza desde fab_sumar_cortados y trigger de sentencia en fab_lineas (flag fab.autoasignando evita recursión). Importación: fab_config.importar_dias_atras = 60. Las prendas sin_vinilo no cuentan ni consumen el contador.
   Sin vinilo (función v6 + migración 10): productos con etiqueta Shopify "sin vinilo" no se cortan; en cada importación se refrescan etiqueta y stock (`fab_lineas.sin_vinilo/stock/variant_id`) y `repartirSinVinilo()` pasa esas prendas de cortar/sin_stock a empaquetar si hay stock (stock Shopify ya descuenta pedidos sin enviar; si es negativo, sin stock los más nuevos).
   Retrasados: no producido y >7 días naturales (urgentes >3) → pestaña "⚠ Retrasados" y etiqueta (solo pantalla).
   Estados POR PRENDA: (pendiente) → cortar ("Cortar y estampar") ⇄ sin_stock → empaquetar. 'estampar' ELIMINADO 9-oct (sigue en el check de BD por compatibilidad). Desde 9-oct las prendas ENTRAN DIRECTAMENTE en `cortar` (default de columna fab_lineas.estado); 'pendiente' queda solo para uso manual y su pestaña se oculta si está vacía. El pedido toma el de su prenda más atrasada (trigger BD).
3. En Empaquetar la salida es AUTOMÁTICA según destino (`destinoOtros()` en web y función): UE (península, Baleares, países UE) = etiqueta GLS; Canarias, Ceuta, Melilla, Reino Unido (+GI/JE/GG/IM) y todo lo no-UE (Suiza, Noruega, Andorra…) = Otros envíos (la función rechaza GLS para esos). Dos salidas: "Otros envíos" (rpc `fab_otro_envio`, envio_tipo='otros' + anotación libre; pestaña "Otros envíos") o "✔ Etiqueta GLS" → función `fab` pide etiqueta a GLS (servicio web SOAP `wsclientes.asmred.com/b2b.asmx`, método GrabaServicios, etiqueta PDF) → la pantalla la imprime → check `etiqueta_impresa`.
   Reparto (migración 08), pensado para PC COMPARTIDO: barra de personas (Todos · Libres · Dania · Irene…; lista en `fab_config.empaquetadoras`, color por persona). "✋ Coger" / "Coger 5 siguientes" preguntan "¿Para quién?" (o usan la persona seleccionada arriba), "Cambiar" y "Soltar" en la tarjeta. rpc `fab_asignar`, columnas `asignado_a/asignado_at`. Vale en cualquier etapa activa. El filtro elegido se recuerda por dispositivo (tablet fija en una persona). El Resumen NO aplica bloqueo.
   Histórico (vista 3, migración 11): pedidos por fecha de salida (empaquetado_at) o de estampado (estampado_at), filtros persona/rol/pedido-cliente, PDF (imp-hist) y Excel. Columnas fab_pedidos.estampado_por/at y empaquetado_por/at: trigger fab_registro_personas (usa asignado_a) + la pantalla pregunta "¿Quién lo ha estampado/empaquetado?" y guarda con rpc fab_marcar_persona. La carga principal ya no trae producidos de hace >30 días.
4. Si `fab_config.shopify_crear_envio = si` y GLS en modo real → `fulfillmentCreate` en Shopify con tracking GLS y aviso al cliente.
5. Pedidos sin dirección = recogida en taller: no generan etiqueta.

## Piezas
- Supabase proyecto `hgvsrmywsfnmvenkfynb`. Tablas `fab_pedidos`, `fab_lineas`, `fab_eventos` (log), `fab_config` (ajustes). Bucket privado `fab-etiquetas`.
- Edge function `supabase/functions/fab/index.ts` (verify_jwt=false, auth propia: JWT de usuario o cabecera `x-fab-cron` = vault `fab_cron_key`). Acciones: importar, lineas, producido, impresa, reimprimir, diag, prueba_gls. Desplegada v5 (9-oct: bloqueo GLS por destino, ?hora=8, log importacion_error). La función también exige que el email esté en `fab_usuarios`.
- Credenciales Shopify: app con client_credentials, secretos en vault (`shopify_shop`, `shopify_client_id`, `shopify_client_secret`) leídos con `public.read_secret` (solo service_role).
- GLS: modo `pruebas` usa el UID público de pruebas; modo `real` usa vault `gls_uid_cliente`.
- Demo sin conexión: abrir `web/index.html?demo`.

## Reglas
- MCP Supabase: cancela (pide confirmación) SQL con DELETE/DROP o UPDATE sin WHERE; poner siempre WHERE y evitar DELETE.
- 9-oct 22:57: limpieza de pruebas (todos los pedidos a cortar, contador a 0, sin GLS/otros/entregas/asignaciones; evento reset_pruebas).
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
- [ ] Cuando Tito dé permisos de escritura (write_orders): guardar en cada pedido de Shopify "Estampado por" y "Empaquetado por" (metafields de pedido, p. ej. singular.estampado_por / singular.empaquetado_por) — pedido explícito de Tito 10-oct. NO activar antes.
- [ ] Impresora de etiquetas (térmica 10x15 o A4) y Chrome con --kiosk-printing en el PC de fábrica.
- [ ] Remitente de la etiqueta: hoy "Carrer de Bosch i Gimpera 20, Nave Manual Color" (confirmar si mostrar Manual Color).
- [x] Repo GitHub: titocostaBcn/singular-fabrica — PÚBLICO desde 9-oct (Netlify gratis bloqueaba despliegues en privado). No subir nunca secretos: todo en vault de Supabase.
- [x] Netlify: proyecto `tallersingular` → https://tallersingular.netlify.app (se publica solo al subir a main).
