-- Pedidos enviados (= preparados) por día en el Dashboard (16-oct-2026, pedido de Tito: «preparados son enviados en Shopify»).
-- La función (sincronizarVentas y la acción «enviados» para el histórico) cuenta cada pedido el día de su primer envío en Shopify.
alter table public.fab_ventas_dia add column if not exists enviados integer not null default 0;
