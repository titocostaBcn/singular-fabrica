-- Ventas por día (12-oct-2026, autorizado por Tito): para el panel de gerencia (Carlota).
-- Las rellena la función fab (acción «ventas», solo lectura de Shopify con read_all_orders):
--   cada mañana tras la importación, los últimos 7 días (recoge devoluciones y cancelaciones recientes),
--   al abrir el panel, el día de hoy, y una carga inicial del histórico desde enero de 2024, por meses.
-- Criterio: día del pedido en hora de Madrid; sin pedidos de prueba; los cancelados no cuentan como venta.
--   total    = lo que pagó la clienta (IVA y envío incluidos, ya con descuentos)
--   devuelto = reembolsado de esos pedidos (se imputa al día del pedido, no al de la devolución)
--   neto     = total − devuelto  (≈ «Ventas totales» de Shopify)
create table if not exists public.fab_ventas_dia (
  dia date primary key,
  pedidos integer not null default 0,
  unidades integer not null default 0,
  total numeric(12,2) not null default 0,
  devuelto numeric(12,2) not null default 0,
  envio numeric(12,2) not null default 0,
  iva numeric(12,2) not null default 0,
  descuentos numeric(12,2) not null default 0,
  cancelados integer not null default 0,
  actualizado_at timestamptz not null default now()
);
create table if not exists public.fab_ventas_producto (
  dia date not null,
  titulo text not null,
  unidades integer not null default 0,
  importe numeric(12,2) not null default 0,
  primary key (dia, titulo)
);
alter table public.fab_ventas_dia enable row level security;
alter table public.fab_ventas_producto enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fab_ventas_dia' and policyname = 'fab_ventas_dia_leer') then
    create policy fab_ventas_dia_leer on public.fab_ventas_dia for select to authenticated using (public.fab_es_usuario());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fab_ventas_producto' and policyname = 'fab_ventas_producto_leer') then
    create policy fab_ventas_producto_leer on public.fab_ventas_producto for select to authenticated using (public.fab_es_usuario());
  end if;
end $$;
revoke all on public.fab_ventas_dia, public.fab_ventas_producto from anon;
grant select on public.fab_ventas_dia, public.fab_ventas_producto to authenticated;

-- Inversión en Meta Ads por día (12-oct-2026, pedido de Tito: comparar con las ventas).
-- Histórico cargado desde Windsor.ai (cuenta publicitaria 551879495597614). Cada mañana la función lo actualiza
-- si en el vault hay `windsor_api_key` (o `meta_token` + `meta_cuenta`); si no, el panel avisa de la fecha del último dato.
--   compras / valor_compras = lo que Meta se atribuye (ventana por defecto de la cuenta), solo como referencia.
create table if not exists public.fab_meta_dia (
  dia date primary key,
  gasto numeric(12,2) not null default 0,
  impresiones integer not null default 0,
  clics integer not null default 0,
  compras integer not null default 0,
  valor_compras numeric(12,2) not null default 0,
  actualizado_at timestamptz not null default now()
);
alter table public.fab_meta_dia enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fab_meta_dia' and policyname = 'fab_meta_dia_leer') then
    create policy fab_meta_dia_leer on public.fab_meta_dia for select to authenticated using (public.fab_es_usuario());
  end if;
end $$;
revoke all on public.fab_meta_dia from anon;
grant select on public.fab_meta_dia to authenticated;
