// fab v8 — Gestión de producción Singular Wardrobe
// Estados por prenda: (pendiente) → cortar (vinilo) → estampar → empaquetar, y sin_stock; el pedido (trigger en BD) toma el de su prenda más atrasada.
// Importación diaria 8:00 Madrid (cron fab_importar_0800). Acciones: importar · actualizar · revisar_cambios · lineas · producido · impresa · reimprimir ·
// shopify_otros · shopify_personas · diag · prueba_gls
// v7: recoge los cambios hechos en Shopify en pedidos ya importados (talla/prenda, cantidad, dirección, nota, envío).
// v8 (ola 1): Sin stock marcado a mano manda sobre el stock de Shopify; prendas quitadas con vinilo asignado lo devuelven al almacén;
//     Shopify (apagado hasta tener permiso de escritura): enviado en Otros envíos y metacampos estampado_por / empaquetado_por.
// Auth: JWT de usuario de la pantalla de fábrica, o cabecera x-fab-cron (vault: fab_cron_key) para la tarea programada.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding@1/base64";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = "2026-01";
const GLS_URL = "https://wsclientes.asmred.com/b2b.asmx";
const GLS_UID_PRUEBAS = "6BAB7A53-3B6D-4D5A-9450-702D2FAC0B11"; // usuario público de pruebas de GLS/ASM
const NACIONAL = new Set(["ES", "PT", "AD"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-fab-cron",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ───────── utilidades ─────────
async function secret(name: string): Promise<string | null> {
  const { data } = await sb.rpc("read_secret", { p_name: name });
  return (data as string) ?? null;
}
async function config(): Promise<Record<string, string>> {
  const { data, error } = await sb.from("fab_config").select("clave,valor");
  if (error) throw new Error(`config: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r) => [r.clave, r.valor]));
}
async function evento(order_id: number | null, tipo: string, detalle: unknown, usuario: string) {
  await sb.from("fab_eventos").insert({ order_id, tipo, detalle, usuario });
}
const idNum = (gid: string) => Number(gid.split("/").pop());
const gidOrder = (id: number) => `gid://shopify/Order/${id}`;
function horaMadrid(): number {
  return Number(new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date()));
}
function fechaMadrid(): string { // dd/mm/yyyy
  return new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
}

// ───────── Shopify ─────────
let SHOP = "", TOKEN = "";
async function shopifyAuth() {
  if (TOKEN) return;
  SHOP = (await secret("shopify_shop"))!;
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: await secret("shopify_client_id"), client_secret: await secret("shopify_client_secret"), grant_type: "client_credentials" }),
  });
  if (!r.ok) throw new Error(`Shopify oauth ${r.status}: ${await r.text()}`);
  TOKEN = (await r.json()).access_token;
}
async function gql(query: string, variables: Record<string, unknown> = {}) {
  await shopifyAuth();
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(`Shopify: ${JSON.stringify(j.errors)}`);
  return j.data;
}

const NODO_PEDIDO = `id name createdAt cancelledAt displayFulfillmentStatus tags note email phone
    shippingAddress { name address1 address2 city province zip countryCodeV2 phone company }
    shippingLine { title }
    lineItems(first: 50) { nodes { id title variantTitle sku currentQuantity customAttributes { key value } image { url }
      variant { id inventoryQuantity inventoryItem { tracked } product { id tags } } } }`;
const Q_PEDIDOS = `query Pedidos($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes { ${NODO_PEDIDO} } } }`;
const Q_PEDIDO = `query Pedido($id: ID!) { order(id: $id) { ${NODO_PEDIDO} } }`;

const esUrgente = (p: any) => /expr[eé]s|urgent/i.test(p.metodo_envio ?? "") || (p.tags ?? []).some((t: string) => /urgent/i.test(t));

// Datos del pedido que vienen de Shopify (se guardan al importar y se refrescan si cambian después)
function datosPedido(o: any) {
  const a = o.shippingAddress ?? {};
  return {
    cliente_nombre: [a.name, a.company].filter(Boolean).join(" · ") || null,
    email: o.email ?? null, telefono: a.phone || o.phone || null,
    direccion1: a.address1 ?? null, direccion2: a.address2 ?? null, ciudad: a.city ?? null, provincia: a.province ?? null,
    cp: a.zip ?? null, pais: a.countryCodeV2 ?? null, metodo_envio: o.shippingLine?.title ?? null,
    nota: o.note ?? null, tags: o.tags ?? [],
  };
}
const persDe = (l: any) => (l.customAttributes ?? []).filter((x: any) => x.value && !x.key.startsWith("_"));
const lineaDe = (l: any, order_id: number) => ({
  line_id: idNum(l.id), order_id, titulo: l.title, variante: l.variantTitle, sku: l.sku,
  cantidad: l.currentQuantity, personalizacion: persDe(l), imagen_url: l.image?.url ?? null, ...datosVariante(l),
});

// Producto con etiqueta "sin vinilo" en Shopify: no se corta; si hay stock pasa solo a Empaquetar, si no a Sin stock.
const esSinVinilo = (tags: string[] | undefined) => (tags ?? []).some((t) => /^\s*sin\s+vinilo\s*$/i.test(t));
const datosVariante = (l: any) => ({
  product_id: l.variant?.product?.id ? idNum(l.variant.product.id) : null,
  variant_id: l.variant?.id ? idNum(l.variant.id) : null,
  sin_vinilo: esSinVinilo(l.variant?.product?.tags),
  stock: l.variant && l.variant.inventoryItem?.tracked !== false ? (l.variant.inventoryQuantity ?? null) : null, // null = sin control de stock
});

// ───────── IMPORTAR ─────────
// Pedidos abiertos sin enviar de los últimos `dias` días
async function leerAbiertos(dias: number) {
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const q = `created_at:>='${desde}' fulfillment_status:unfulfilled status:open`;
  const pedidos: any[] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d = await gql(Q_PEDIDOS, { q, after });
    pedidos.push(...d.orders.nodes);
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return pedidos;
}
// Pedidos de la BD (con sus prendas) por order_id
async function pedidosBD(ids: number[]) {
  const m = new Map<number, any>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("fab_pedidos").select("*, fab_lineas(*)").in("order_id", ids.slice(i, i + 100));
    if (error) throw new Error(`pedidos BD: ${error.message}`);
    for (const p of data ?? []) m.set(Number(p.order_id), p);
  }
  return m;
}

async function importar(usuario: string) {
  const cfg = await config();
  const pedidos = await leerAbiertos(Number(cfg.importar_dias_atras ?? "7"));

  const ids = pedidos.map((o) => idNum(o.id));
  const { data: existentes } = await sb.from("fab_pedidos").select("order_id").in("order_id", ids.length ? ids : [0]);
  const ya = new Set((existentes ?? []).map((r) => Number(r.order_id)));

  let nuevos = 0;
  for (const o of pedidos) {
    const order_id = idNum(o.id);
    if (ya.has(order_id) || o.cancelledAt) continue;
    const { error } = await sb.from("fab_pedidos").insert({
      order_id, order_name: o.name, creado_shopify: o.createdAt, ...datosPedido(o), peso_kg: Number(cfg.peso_defecto_kg ?? "1"),
    });
    if (error) { await evento(order_id, "error_importacion", { error: error.message }, usuario); continue; }
    const lineas = o.lineItems.nodes.filter((l: any) => l.currentQuantity > 0).map((l: any) => lineaDe(l, order_id));
    if (lineas.length) await sb.from("fab_lineas").insert(lineas);
    nuevos++;
  }

  // Pedidos ya importados: cambios hechos en Shopify (si está activado) y etiqueta "sin vinilo" / stock de sus prendas
  const sincro = cfg.sincronizar_cambios === "si";
  const enBD = sincro ? await pedidosBD(ids.filter((id) => ya.has(id))) : new Map();
  let modificados = 0;
  for (const o of pedidos) {
    const id = idNum(o.id);
    if (!ya.has(id)) continue;
    if (sincro) {
      try {
        const r = await sincronizar(o, enBD.get(id), usuario, true);
        if (r?.cambios.length) modificados++;
      } catch (e) {
        await evento(id, "error_sincronizar", { error: String((e as Error).message ?? e) }, usuario);
      }
    }
    for (const l of o.lineItems.nodes) {
      if (!l.variant || !(l.currentQuantity > 0)) continue;
      await sb.from("fab_lineas").update(datosVariante(l)).eq("line_id", idNum(l.id));
    }
  }
  const sinVinilo = await repartirSinVinilo(usuario);

  // Revisar pedidos abiertos en la BD: cancelados o enviados por fuera del sistema
  const { data: abiertos } = await sb.from("fab_pedidos").select("order_id")
    .is("gls_codbarras", null).eq("cancelado", false).eq("enviado_fuera", false);
  let cancelados = 0, fuera = 0;
  const lista = (abiertos ?? []).map((r) => Number(r.order_id));
  for (let i = 0; i < lista.length; i += 100) {
    const d = await gql(`query Estado($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id cancelledAt displayFulfillmentStatus } } }`,
      { ids: lista.slice(i, i + 100).map(gidOrder) });
    for (const n of d.nodes ?? []) {
      if (!n) continue;
      if (n.cancelledAt) { await sb.from("fab_pedidos").update({ cancelado: true }).eq("order_id", idNum(n.id)); cancelados++; }
      else if (n.displayFulfillmentStatus === "FULFILLED") { await sb.from("fab_pedidos").update({ enviado_fuera: true }).eq("order_id", idNum(n.id)); fuera++; }
    }
  }

  const res = { revisados: pedidos.length, nuevos, cancelados, enviados_fuera: fuera, sin_vinilo: sinVinilo, ...(sincro ? { modificados } : {}) };
  await evento(null, "importacion", res, usuario);
  return res;
}

// ───────── CAMBIOS EN SHOPIFY DE PEDIDOS YA IMPORTADOS ─────────
// Talla o prenda («Editar pedido»: se quita una y se añade otra), cantidad, dirección, teléfono, nota o tipo de envío.
// No se tocan pedidos producidos, cancelados o enviados por fuera. El texto de personalización de una prenda que ya
// estaba no se toca (Shopify no deja cambiarlo; se corrige en la pantalla con fab_corregir_personalizacion).
// Cada cambio deja un aviso en fab_pedidos.modificado (la pantalla muestra «✏️ Modificado» hasta pulsar Visto).
const sinVacio = (v: unknown) => (v === "" || v === undefined ? null : v);
const igual = (a: unknown, b: unknown) => JSON.stringify(sinVacio(a)) === JSON.stringify(sinVacio(b));
const prendaTxt = (titulo: string, variante: string | null, n: number) => `${n} × ${titulo}${variante ? " · " + variante : ""}`;
const persTxt = (pers: any[]) => (pers ?? []).map((x: any) => x.value).filter(Boolean).join(" · ");

async function sincronizar(o: any, p: any, usuario: string, aplicar: boolean) {
  if (!p || o.cancelledAt || p.estado === "producido" || p.cancelado || p.enviado_fuera) return null;
  const order_id = Number(p.order_id);
  const cambios: string[] = [];

  // 1. Datos del pedido
  const nuevo: Record<string, any> = datosPedido(o);
  const upd: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(nuevo)) if (!igual(p[k], v)) upd[k] = v;
  if (["direccion1", "direccion2", "ciudad", "provincia", "cp", "pais"].some((k) => k in upd)) {
    cambios.push(nuevo.direccion1
      ? `Dirección de envío: ${[nuevo.direccion1, nuevo.direccion2].filter(Boolean).join(", ")} · ${nuevo.cp ?? ""} ${nuevo.ciudad ?? ""}${nuevo.pais && nuevo.pais !== "ES" ? ` (${nuevo.pais})` : ""}`.replace(/\s+/g, " ").trim()
      : "Ahora es recogida en taller (sin dirección de envío)");
  }
  if ("cliente_nombre" in upd) cambios.push(`Destinatario: ${nuevo.cliente_nombre ?? "—"}`);
  if ("telefono" in upd) cambios.push(`Teléfono: ${nuevo.telefono ?? "—"}`);
  if ("metodo_envio" in upd) cambios.push(`Tipo de envío: ${nuevo.metodo_envio ?? "—"}`);
  if ("nota" in upd) cambios.push(nuevo.nota ? `Nota del cliente: «${nuevo.nota}»` : "Nota del cliente borrada");
  const urgAhora = esUrgente({ ...p, ...upd });
  if (esUrgente(p) !== urgAhora) cambios.push(urgAhora ? "Ahora es URGENTE" : "Ya no es urgente");

  // 2. Prendas
  const act = (o.lineItems?.nodes ?? []).filter((l: any) => l.currentQuantity > 0);
  const db = new Map<number, any>((p.fab_lineas ?? []).map((l: any) => [Number(l.line_id), l]));
  const enShop = new Set(act.map((l: any) => idNum(l.id)));
  const nuevas = act.filter((l: any) => !db.has(idNum(l.id)));
  let quitadas = [...db.values()].filter((l) => !enShop.has(Number(l.line_id)));
  const cantidades: { line_id: number; cantidad: number; vuelve: boolean }[] = [];
  if (!act.length) {
    // Shopify ya no tiene prendas en el pedido (¿devuelto o reembolsado sin cancelar?): no se quita nada, solo se avisa
    if (db.size) cambios.push("En Shopify este pedido ya no tiene prendas: revisar con la tienda antes de hacerlo");
    quitadas = [];
  } else {
    const yaHecha = (l: any) => l.estado === "estampar" ? " (tenía su vinilo cortado: vuelve al almacén)"
      : l.estado !== "empaquetar" ? "" : l.sin_vinilo ? " (ya estaba preparada: devuélvela a la estantería)" : " (ya estaba hecha: apártala)";
    // Cambio de talla o color de la misma prenda (se quita una y se añade otra del mismo modelo): un solo aviso
    const emparejadas = new Set<any>();
    for (const n of nuevas) {
      const q = quitadas.find((l) => !emparejadas.has(l) && l.titulo === n.title && l.cantidad === n.currentQuantity);
      if (!q) continue;
      emparejadas.add(q); emparejadas.add(n);
      const pers = persTxt(persDe(n));
      cambios.push(`Cambio de ${n.currentQuantity > 1 ? n.currentQuantity + " × " : ""}${n.title}: ${q.variante ?? "—"} → ${n.variantTitle ?? "—"}${pers ? ` · «${pers}»` : ""}${yaHecha(q)}`);
    }
    for (const l of nuevas) {
      if (emparejadas.has(l)) continue;
      const pers = persTxt(persDe(l));
      cambios.push(`Prenda añadida: ${prendaTxt(l.title, l.variantTitle, l.currentQuantity)}${pers ? ` · «${pers}»` : ""}`);
    }
    for (const l of quitadas) {
      if (emparejadas.has(l)) continue;
      const pers = persTxt(l.personalizacion);
      cambios.push(`Prenda quitada: ${prendaTxt(l.titulo, l.variante, l.cantidad)}${pers ? ` · «${pers}»` : ""}${yaHecha(l)}`);
    }
    for (const s of act) {
      const l = db.get(idNum(s.id));
      if (!l || l.cantidad === s.currentQuantity) continue;
      const mas = s.currentQuantity > l.cantidad, hecha = !["pendiente", "sin_stock", "cortar"].includes(l.estado);
      const n = l.cantidad - s.currentQuantity;
      cantidades.push({ line_id: Number(l.line_id), cantidad: s.currentQuantity, vuelve: mas && hecha });
      cambios.push(`Cantidad de ${l.titulo}${l.variante ? " · " + l.variante : ""}: ${l.cantidad} → ${s.currentQuantity}` +
        (mas && hecha ? " (vuelve a Cortar y estampar)" : !mas && hecha ? (n === 1 ? " (sobra 1 ya hecha: apártala)" : ` (sobran ${n} ya hechas: apártalas)`) : ""));
    }
  }

  const previos = new Set<string>(p.modificado ?? []);
  const avisos = cambios.filter((c) => !previos.has(c)); // no repetir avisos que aún no se han visto
  const campos = Object.keys(upd);
  const res = { order_id, order_name: p.order_name, cambios, campos };
  if (!campos.length && !nuevas.length && !quitadas.length && !cantidades.length && !avisos.length) return { ...res, cambios: [] };
  if (!aplicar) return { ...res, simulado: true };

  const ahora = new Date().toISOString();
  if (campos.length || avisos.length) {
    const { error } = await sb.from("fab_pedidos").update({
      ...upd,
      ...(avisos.length ? { modificado: [...(p.modificado ?? []), ...avisos], modificado_at: ahora, modificado_visto_at: null, modificado_visto_por: null } : {}),
    }).eq("order_id", order_id);
    if (error) throw new Error(`${p.order_name}: ${error.message}`);
  }
  if (nuevas.length) {
    const { error } = await sb.from("fab_lineas").insert(nuevas.map((l: any) => lineaDe(l, order_id)));
    if (error) throw new Error(`${p.order_name} (prendas nuevas): ${error.message}`);
  }
  for (const c of cantidades) {
    await sb.from("fab_lineas").update(c.vuelve ? { cantidad: c.cantidad, estado: "cortar", estado_at: ahora, estado_por: "cambio en Shopify" } : { cantidad: c.cantidad })
      .eq("line_id", c.line_id);
  }
  if (quitadas.length) {
    // Las que ya tenían vinilo asignado (Estampar) pasan antes a Sin stock: así su vinilo vuelve al almacén (trigger en BD)
    const conVinilo = quitadas.filter((l) => l.estado === "estampar").map((l) => l.line_id);
    if (conVinilo.length) await sb.from("fab_lineas").update({ estado: "sin_stock", estado_at: ahora, estado_por: "cambio en Shopify" }).in("line_id", conVinilo);
    const { error } = await sb.from("fab_lineas").delete().in("line_id", quitadas.map((l) => l.line_id));
    if (error) throw new Error(`${p.order_name} (prendas quitadas): ${error.message}`);
    await sb.rpc("fab_recalcular_estado", { p_order_id: order_id }); // la etapa del pedido y la asignación automática
  }
  await evento(order_id, "cambio_shopify", { cambios, campos: upd, nuevas: nuevas.map((l: any) => idNum(l.id)), quitadas, cantidades }, usuario);
  return res;
}

// Prendas "sin vinilo" en Cortar / Sin stock → Empaquetar si hay stock, si no Sin stock.
// El stock de Shopify ("disponible") ya descuenta todos los pedidos sin enviar: si es >= 0 hay para todos;
// si es negativo faltan esas unidades y se quedan sin stock los pedidos más nuevos (urgentes y antiguos primero).
// Una prenda que una persona ha marcado Sin stock (recogida «No hay» o botón Sin stock) NO se saca de Sin stock
// aunque Shopify diga que hay: manda lo que se ve en la estantería. Vuelve con «¿Ha llegado? Sí».
async function repartirSinVinilo(usuario: string) {
  const { data } = await sb.from("fab_lineas")
    .select("line_id, order_id, variant_id, cantidad, estado, estado_por, stock, fab_pedidos!inner(creado_shopify, metodo_envio, tags, estado, cancelado, enviado_fuera)")
    .eq("sin_vinilo", true).in("estado", ["cortar", "sin_stock"])
    .neq("fab_pedidos.estado", "producido").eq("fab_pedidos.cancelado", false).eq("fab_pedidos.enviado_fuera", false);
  const urg = (p: any) => /expr[eé]s|urgent/i.test(p.metodo_envio ?? "") || (p.tags ?? []).some((t: string) => /urgent/i.test(t));
  const ls = (data ?? []).filter((l: any) => l.estado !== "sin_stock" || l.estado_por === "auto sin vinilo").sort((a: any, b: any) => (Number(urg(b.fab_pedidos)) - Number(urg(a.fab_pedidos))) ||
    (new Date(a.fab_pedidos.creado_shopify).getTime() - new Date(b.fab_pedidos.creado_shopify).getTime()));
  const porVar = new Map<string, any[]>();
  for (const l of ls) { const k = String(l.variant_id ?? "l" + l.line_id); porVar.set(k, [...(porVar.get(k) ?? []), l]); }
  const disponibles: number[] = [], agotadas: number[] = [];
  for (const grupo of porVar.values()) {
    const stock = grupo[0].stock;
    const total = grupo.reduce((s, l) => s + l.cantidad, 0);
    let cubiertas = stock == null || stock >= 0 ? total : Math.max(total + stock, 0);
    for (const l of grupo) {
      if (cubiertas >= l.cantidad) { cubiertas -= l.cantidad; if (l.estado !== "empaquetar") disponibles.push(l.line_id); }
      else if (l.estado !== "sin_stock") agotadas.push(l.line_id);
    }
  }
  const ahora = new Date().toISOString();
  if (disponibles.length) await sb.from("fab_lineas").update({ estado: "empaquetar", estado_at: ahora, estado_por: "auto sin vinilo" }).in("line_id", disponibles);
  if (agotadas.length) await sb.from("fab_lineas").update({ estado: "sin_stock", estado_at: ahora, estado_por: "auto sin vinilo" }).in("line_id", agotadas);
  if (disponibles.length || agotadas.length) await evento(null, "sin_vinilo", { disponibles, agotadas }, usuario);
  return { disponibles: disponibles.length, sin_stock: agotadas.length };
}

// ───────── GLS ─────────
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").trim();
function telefono(t: string | null): string {
  let x = (t ?? "").replace(/[^\d+]/g, "");
  if (x.startsWith("+34")) x = x.slice(3);
  else if (x.startsWith("0034")) x = x.slice(4);
  return x;
}

async function glsGrabar(p: any, cfg: Record<string, string>) {
  const modo = cfg.gls_modo === "real" ? "real" : "pruebas";
  const uid = modo === "real" ? await secret("gls_uid_cliente") : GLS_UID_PRUEBAS;
  if (!uid) throw new Error("Falta el UID de cliente GLS en el vault (gls_uid_cliente)");
  const nac = NACIONAL.has((p.pais ?? "ES").toUpperCase());
  const servicio = nac ? cfg.gls_servicio_nacional : cfg.gls_servicio_internacional;
  const horario = nac ? cfg.gls_horario_nacional : cfg.gls_horario_internacional;
  const ref = String(p.order_name).replace(/[^0-9A-Za-z-]/g, "").slice(0, 15);
  const tel = telefono(p.telefono);
  const direccion = [p.direccion1, p.direccion2].filter(Boolean).join(", ");

  const docIn = `<Servicios uidcliente="${uid}" xmlns="http://www.asmred.com/">
  <Envio codbarras="">
    <Fecha>${fechaMadrid()}</Fecha>
    <Portes>P</Portes>
    <Servicio>${esc(servicio)}</Servicio>
    <Horario>${esc(horario)}</Horario>
    <Bultos>${p.bultos ?? 1}</Bultos>
    <Peso>${p.peso_kg ?? 1}</Peso>
    <Retorno>0</Retorno>
    <Pod>N</Pod>
    <Remite>
      <Nombre>${esc(cfg.remite_nombre)}</Nombre>
      <Direccion>${esc(cfg.remite_direccion)}</Direccion>
      <Poblacion>${esc(cfg.remite_poblacion)}</Poblacion>
      <Provincia>${esc(cfg.remite_provincia)}</Provincia>
      <Pais>34</Pais>
      <CP>${esc(cfg.remite_cp)}</CP>
      <Telefono>${esc(cfg.remite_telefono)}</Telefono>
      <Email>${esc(cfg.remite_email)}</Email>
    </Remite>
    <Destinatario>
      <Nombre>${esc(p.cliente_nombre)}</Nombre>
      <Direccion>${esc(direccion)}</Direccion>
      <Poblacion>${esc(p.ciudad)}</Poblacion>
      <Provincia>${esc(p.provincia)}</Provincia>
      <Pais>${esc(p.pais ?? "ES")}</Pais>
      <CP>${esc(p.cp)}</CP>
      <Telefono>${esc(tel)}</Telefono>
      <Movil>${esc(tel)}</Movil>
      <Email>${esc(p.email)}</Email>
      <Observaciones></Observaciones>
    </Destinatario>
    <Referencias><Referencia tipo="C">${esc(ref)}</Referencia></Referencias>
    <DevuelveAdicionales><Etiqueta tipo="PDF" /></DevuelveAdicionales>
  </Envio>
</Servicios>`;

  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
<soap12:Body><GrabaServicios xmlns="http://www.asmred.com/"><docIn>${docIn}</docIn></GrabaServicios></soap12:Body></soap12:Envelope>`;

  const r = await fetch(GLS_URL, { method: "POST", headers: { "Content-Type": "application/soap+xml; charset=utf-8" }, body });
  const xml = await r.text();
  const envioTag = xml.match(/<Envio\b[^>]*>/)?.[0] ?? "";
  const attr = (n: string) => envioTag.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1] ?? null;
  const ret = Number(xml.match(/<Resultado[^>]*return="(-?\d+)"/)?.[1] ?? "NaN");
  const errores = [...xml.matchAll(/<Error>([^<]*)<\/Error>/g)].map((m) => m[1]).join(" | ");
  const pdf = xml.match(/<Etiqueta[^>]*>([A-Za-z0-9+/=\s]+)<\/Etiqueta>/)?.[1]?.replace(/\s/g, "") ?? null;
  const codbarras = attr("codbarras");

  if (!r.ok || ret !== 0 || !codbarras) {
    throw Object.assign(new Error(`GLS ${r.status} return=${ret} ${errores}`.trim()), { raw: xml.slice(0, 3000) });
  }
  return { modo, codbarras, uid: attr("uid"), pdf, raw: pdf ? null : xml.slice(0, 3000) };
}

async function glsEtiquetaEnvio(codigo: string): Promise<string | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>
<EtiquetaEnvio xmlns="http://www.asmred.com/"><codigo>${esc(codigo)}</codigo><tipoEtiqueta>PDF</tipoEtiqueta></EtiquetaEnvio>
</soap12:Body></soap12:Envelope>`;
  const r = await fetch(GLS_URL, { method: "POST", headers: { "Content-Type": "application/soap+xml; charset=utf-8" }, body });
  const xml = await r.text();
  return xml.match(/<base64Binary>([^<]+)<\/base64Binary>/)?.[1]?.replace(/\s/g, "") ?? null;
}

// ───────── Shopify: marcar enviado ─────────
async function shopifyEnviar(p: any) {
  const d = await gql(`query FO($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`, { id: gidOrder(p.order_id) });
  const fos = (d.order?.fulfillmentOrders?.nodes ?? []).filter((f: any) => ["OPEN", "IN_PROGRESS"].includes(f.status));
  if (!fos.length) throw new Error("El pedido no tiene nada pendiente de enviar en Shopify");
  const m = await gql(`mutation Envio($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`, {
    f: {
      lineItemsByFulfillmentOrder: fos.map((f: any) => ({ fulfillmentOrderId: f.id })),
      // GLS: con su número de seguimiento. Otros envíos: sin seguimiento (la anotación queda en la fábrica).
      ...(p.gls_codbarras ? { trackingInfo: { company: "GLS Spain, S.A.", number: p.gls_codbarras, url: `https://mygls.gls-spain.es/e/${p.gls_codbarras}/${(p.cp ?? "").replace(/\s/g, "")}` } } : {}),
      notifyCustomer: true,
    },
  });
  const ue = m.fulfillmentCreate.userErrors;
  if (ue.length) throw new Error(ue.map((e: any) => e.message).join("; "));
  return m.fulfillmentCreate.fulfillment.id as string;
}

// Quién lo estampó y quién lo empaquetó, en el pedido de Shopify (metacampos singular.estampado_por / empaquetado_por).
// Solo con fab_config.shopify_guardar_personas = si (necesita permiso de escritura de pedidos en la app de Shopify).
async function shopifyPersonas(p: any) {
  const metafields = [["estampado_por", p.estampado_por], ["empaquetado_por", p.empaquetado_por]]
    .filter(([, v]) => v).map(([key, value]) => ({ ownerId: gidOrder(p.order_id), namespace: "singular", key, type: "single_line_text_field", value }));
  if (!metafields.length) return 0;
  const m = await gql(`mutation Personas($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key } userErrors { field message } } }`, { m: metafields });
  const ue = m.metafieldsSet.userErrors;
  if (ue.length) throw new Error(ue.map((e: any) => e.message).join("; "));
  return metafields.length;
}

// Destinos que NO llevan etiqueta GLS (van por "Otros envíos"): Canarias, Ceuta, Melilla, Reino Unido y todo lo que no sea UE.
// Misma regla que destinoOtros() en web/index.html.
const UE_GLS = new Set("ES PT FR DE IT NL BE LU AT IE DK SE FI PL CZ SK SI HU HR RO BG GR CY MT EE LV LT".split(" "));
function destinoOtros(p: any): string | null {
  if (!p.direccion1) return null; // recogida en taller
  const pais = String(p.pais ?? "ES").toUpperCase(), cp = String(p.cp ?? "").trim(), prov = String(p.provincia ?? "").toLowerCase();
  if (["GB", "GG", "JE", "IM", "GI"].includes(pais)) return "Reino Unido";
  if (pais === "IC" || (pais === "ES" && (/^3[58]/.test(cp) || /palmas|tenerife|canari/.test(prov)))) return "Canarias";
  if (pais === "EA" || (pais === "ES" && (/^51/.test(cp) || prov.includes("ceuta")))) return "Ceuta";
  if (pais === "ES" && (/^52/.test(cp) || prov.includes("melilla"))) return "Melilla";
  if (!UE_GLS.has(pais)) return "Fuera de la UE";
  return null;
}

// ───────── PRODUCIDO ─────────
async function producido(order_id: number, usuario: string) {
  const cfg = await config();
  const { data: dest } = await sb.from("fab_pedidos").select("direccion1, pais, cp, provincia").eq("order_id", order_id).maybeSingle();
  const zona = dest && destinoOtros(dest);
  if (zona) return { ok: false, error: `${zona}: este pedido va por Otros envíos, no por GLS` };
  // Bloqueo para que dos toques seguidos no generen dos envíos en GLS
  const { data: lock } = await sb.from("fab_pedidos")
    .update({ estado: "producido", estado_at: new Date().toISOString(), estado_por: usuario, gls_uid: "EN_CURSO", gls_error: null })
    .eq("order_id", order_id).eq("cancelado", false).is("gls_codbarras", null).eq("estado", "empaquetar")
    .or("gls_uid.is.null,gls_uid.neq.EN_CURSO").select().maybeSingle();

  let p: any = lock;
  let pdfB64: string | null = null;

  // Recogida en taller (sin dirección de envío): no hay etiqueta GLS
  if (lock && !lock.direccion1) {
    await sb.from("fab_pedidos").update({ gls_uid: null }).eq("order_id", order_id);
    await evento(order_id, "listo_recogida", null, usuario);
    return { ok: true, recogida: true };
  }

  if (lock) {
    try {
      const g = await glsGrabar(lock, cfg);
      let path: string | null = null;
      if (g.pdf) {
        path = `${order_id}/${g.codbarras}.pdf`;
        await sb.storage.from("fab-etiquetas").upload(path, decodeBase64(g.pdf), { contentType: "application/pdf", upsert: true });
        pdfB64 = g.pdf;
      }
      const { data } = await sb.from("fab_pedidos").update({ gls_codbarras: g.codbarras, gls_uid: g.uid, gls_modo: g.modo, etiqueta_path: path })
        .eq("order_id", order_id).select().single();
      p = data;
      await evento(order_id, "gls_ok", { modo: g.modo, codbarras: g.codbarras, sin_pdf_raw: g.raw }, usuario);
    } catch (e) {
      await sb.from("fab_pedidos").update({ gls_uid: null, gls_error: String((e as Error).message) }).eq("order_id", order_id);
      await evento(order_id, "gls_error", { error: String((e as Error).message), raw: (e as any).raw ?? null }, usuario);
      return { ok: false, error: `GLS: ${(e as Error).message}` };
    }
  } else {
    const { data } = await sb.from("fab_pedidos").select().eq("order_id", order_id).maybeSingle();
    if (!data) return { ok: false, error: "Pedido no encontrado" };
    if (data.cancelado) return { ok: false, error: "Pedido cancelado en Shopify" };
    if (data.gls_uid === "EN_CURSO") return { ok: false, error: "Ya se está generando la etiqueta, espera unos segundos" };
    if (data.estado !== "producido") return { ok: false, error: "Faltan prendas por pasar a Empaquetar" };
    if (!data.direccion1) return { ok: true, recogida: true };
    p = data; // ya tenía etiqueta: solo reimprimir / reintentar Shopify
    pdfB64 = await pdfDe(p);
  }

  // Avisar a Shopify (solo si está activado y en modo real)
  let shopify: string = "desactivado";
  if (cfg.shopify_crear_envio === "si" && p.gls_modo === "real" && !p.shopify_fulfillment_id) {
    try {
      const fid = await shopifyEnviar(p);
      await sb.from("fab_pedidos").update({ shopify_fulfillment_id: fid, shopify_error: null }).eq("order_id", order_id);
      await evento(order_id, "shopify_enviado", { fulfillment: fid }, usuario);
      shopify = "ok";
    } catch (e) {
      await sb.from("fab_pedidos").update({ shopify_error: String((e as Error).message) }).eq("order_id", order_id);
      await evento(order_id, "shopify_error", { error: String((e as Error).message) }, usuario);
      shopify = `error: ${(e as Error).message}`;
    }
  } else if (p.shopify_fulfillment_id) shopify = "ok";

  return { ok: true, codbarras: p.gls_codbarras, modo: p.gls_modo, pdf: pdfB64, shopify };
}

async function pdfDe(p: any): Promise<string | null> {
  if (p.etiqueta_path) {
    const { data } = await sb.storage.from("fab-etiquetas").download(p.etiqueta_path);
    if (data) return encodeBase64(new Uint8Array(await data.arrayBuffer()));
  }
  return p.gls_codbarras ? await glsEtiquetaEnvio(p.gls_codbarras) : null;
}

// ───────── servidor ─────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const accion = body.accion ?? url.searchParams.get("accion");

    // Autenticación
    let usuario = "";
    const cronKey = req.headers.get("x-fab-cron");
    if (cronKey) {
      if (cronKey !== (await secret("fab_cron_key"))) return json({ ok: false, error: "no autorizado" }, 401);
      usuario = "cron";
    } else {
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data } = await sb.auth.getUser(jwt);
      if (!data?.user?.email) return json({ ok: false, error: "no autorizado" }, 401);
      // Solo emails dados de alta en fab_usuarios (este Supabase tiene otros usuarios, p. ej. de TDP)
      const { data: alta } = await sb.from("fab_usuarios").select("email").eq("email", data.user.email.toLowerCase()).maybeSingle();
      if (!alta) return json({ ok: false, error: "usuario sin acceso a fábrica" }, 403);
      usuario = data.user.email;
    }

    if (accion === "importar") {
      // El cron llama a 2 horas UTC (verano/invierno); solo actúa si en Madrid es la hora indicada (?hora=8)
      const hora = url.searchParams.get("hora") ?? (url.searchParams.get("solo7") === "1" ? "7" : null);
      if (usuario === "cron" && hora && horaMadrid() !== Number(hora)) return json({ ok: true, omitido: `no son las ${hora} en Madrid` });
      try {
        return json({ ok: true, ...(await importar(usuario)) });
      } catch (e) {
        // Queda registrado: la pantalla muestra "ERROR no actualizado hoy" si no hay importación correcta del día
        await evento(null, "importacion_error", { error: String((e as Error).message ?? e) }, usuario);
        throw e;
      }
    }

    const order_id = Number(body.order_id);
    if (accion === "actualizar") {
      // Un pedido: lo vuelve a leer de Shopify y aplica los cambios (con simular: true solo los enseña)
      const simular = body.simular === true;
      const d = await gql(Q_PEDIDO, { id: gidOrder(order_id) });
      if (!d.order) return json({ ok: false, error: "No se encuentra el pedido en Shopify" }, 404);
      const p = (await pedidosBD([order_id])).get(order_id);
      if (!p) return json({ ok: false, error: "Este pedido no está importado" }, 404);
      if (p.estado === "producido") return json({ ok: false, error: "El pedido ya ha salido: no se actualiza" }, 409);
      if (d.order.cancelledAt && !p.cancelado) {
        if (!simular) {
          await sb.from("fab_pedidos").update({ cancelado: true }).eq("order_id", order_id);
          await evento(order_id, "cancelado_shopify", null, usuario);
        }
        return json({ ok: true, order_id, cambios: ["Pedido cancelado en Shopify"], simulado: simular || undefined });
      }
      const r = await sincronizar(d.order, p, usuario, !simular);
      if (!simular) {
        for (const l of d.order.lineItems.nodes) {
          if (l.variant && l.currentQuantity > 0) await sb.from("fab_lineas").update(datosVariante(l)).eq("line_id", idNum(l.id));
        }
        await repartirSinVinilo(usuario);
      }
      return json({ ok: true, ...(r ?? { order_id, cambios: [] }) });
    }
    if (accion === "revisar_cambios") {
      // Simulación para todos los pedidos abiertos: qué cambiaría al sincronizar con Shopify. No toca nada.
      const cfg = await config();
      const abiertos = await leerAbiertos(Number(cfg.importar_dias_atras ?? "7"));
      const enBD = await pedidosBD(abiertos.map((o) => idNum(o.id)));
      const conCambios: any[] = [];
      for (const o of abiertos) {
        const r = await sincronizar(o, enBD.get(idNum(o.id)), usuario, false);
        if (r && (r.cambios.length || r.campos.length)) conCambios.push(r);
      }
      return json({ ok: true, revisados: abiertos.length, en_bd: enBD.size, sincronizar_cambios: cfg.sincronizar_cambios ?? "no", pedidos: conCambios });
    }
    if (accion === "lineas") {
      const estado = body.estado;
      const ids: number[] = (body.line_ids ?? []).map(Number).filter(Boolean);
      if (!["pendiente", "sin_stock", "cortar", "estampar", "empaquetar"].includes(estado)) return json({ ok: false, error: "estado no válido" }, 400);
      if (!ids.length || ids.length > 500) return json({ ok: false, error: "selección vacía o demasiado grande" }, 400);
      // No se tocan prendas de pedidos ya producidos, cancelados o enviados por fuera
      const { data: ls } = await sb.from("fab_lineas").select("line_id, order_id, fab_pedidos!inner(estado, cancelado, enviado_fuera)")
        .in("line_id", ids).neq("fab_pedidos.estado", "producido").eq("fab_pedidos.cancelado", false).eq("fab_pedidos.enviado_fuera", false);
      const ok = (ls ?? []).map((l: any) => l.line_id);
      if (!ok.length) return json({ ok: false, error: "Ninguna prenda se puede mover (pedido producido o cancelado)" }, 409);
      const { error } = await sb.from("fab_lineas").update({ estado, estado_at: new Date().toISOString(), estado_por: usuario }).in("line_id", ok);
      if (error) return json({ ok: false, error: error.message }, 500);
      const porPedido = new Map<number, number[]>();
      for (const l of ls as any[]) porPedido.set(l.order_id, [...(porPedido.get(l.order_id) ?? []), l.line_id]);
      await sb.from("fab_eventos").insert([...porPedido].map(([order_id, line_ids]) => ({ order_id, tipo: "lineas", detalle: { estado, line_ids }, usuario })));
      return json({ ok: true, n: ok.length, omitidas: ids.length - ok.length });
    }
    if (accion === "producido") return json(await producido(order_id, usuario));
    if (accion === "shopify_otros") {
      // Pedido que ha salido por Otros envíos: marcarlo como enviado en Shopify (si está activado)
      const cfg = await config();
      if (cfg.shopify_crear_envio !== "si") return json({ ok: true, shopify: "desactivado" });
      const { data: p } = await sb.from("fab_pedidos").select().eq("order_id", order_id).maybeSingle();
      if (!p || p.estado !== "producido" || p.envio_tipo !== "otros") return json({ ok: false, error: "El pedido no ha salido por Otros envíos" }, 409);
      if (p.shopify_fulfillment_id) return json({ ok: true, shopify: "ok" });
      try {
        const fid = await shopifyEnviar(p);
        await sb.from("fab_pedidos").update({ shopify_fulfillment_id: fid, shopify_error: null }).eq("order_id", order_id);
        await evento(order_id, "shopify_enviado", { fulfillment: fid, otros: true }, usuario);
        return json({ ok: true, shopify: "ok" });
      } catch (e) {
        await sb.from("fab_pedidos").update({ shopify_error: String((e as Error).message) }).eq("order_id", order_id);
        await evento(order_id, "shopify_error", { error: String((e as Error).message), otros: true }, usuario);
        return json({ ok: false, error: `Shopify: ${(e as Error).message}` });
      }
    }
    if (accion === "shopify_personas") {
      const cfg = await config();
      if (cfg.shopify_guardar_personas !== "si") return json({ ok: true, shopify: "desactivado" });
      const { data: p } = await sb.from("fab_pedidos").select("order_id, estampado_por, empaquetado_por").eq("order_id", order_id).maybeSingle();
      if (!p) return json({ ok: false, error: "Pedido no encontrado" }, 404);
      try {
        const n = await shopifyPersonas(p);
        await evento(order_id, "shopify_personas", { n }, usuario);
        return json({ ok: true, n });
      } catch (e) {
        await evento(order_id, "shopify_error", { error: String((e as Error).message), personas: true }, usuario);
        return json({ ok: false, error: `Shopify: ${(e as Error).message}` });
      }
    }
    if (accion === "impresa") {
      await sb.from("fab_pedidos").update({ etiqueta_impresa: true, etiqueta_impresa_at: new Date().toISOString() }).eq("order_id", order_id);
      await evento(order_id, "etiqueta_impresa", null, usuario);
      return json({ ok: true });
    }
    if (accion === "reimprimir") {
      const { data: p } = await sb.from("fab_pedidos").select().eq("order_id", order_id).single();
      const pdf = await pdfDe(p);
      await evento(order_id, "reimpresion", { ok: !!pdf }, usuario);
      return json({ ok: !!pdf, pdf, error: pdf ? undefined : "No se pudo recuperar la etiqueta" });
    }
    if (accion === "diag") {
      const d = await gql(`query { currentAppInstallation { accessScopes { handle } } }`);
      return json({ ok: true, usuario, scopes: d.currentAppInstallation.accessScopes.map((s: any) => s.handle), gls_uid_real: !!(await secret("gls_uid_cliente")), config: await config() });
    }
    if (accion === "prueba_gls") {
      // Graba un envío de prueba en el entorno de pruebas de GLS (no genera envío real)
      const cfg = await config();
      const g = await glsGrabar({ order_name: "PRUEBA1", cliente_nombre: "Prueba Singular", direccion1: "Calle Mayor 1", ciudad: "Madrid", provincia: "Madrid", cp: "28013", pais: "ES", telefono: "600000000", email: "hola@singularwardrobe.com", bultos: 1, peso_kg: 1 }, { ...cfg, gls_modo: "pruebas" });
      return json({ ok: true, codbarras: g.codbarras, uid: g.uid, pdf_bytes: g.pdf ? decodeBase64(g.pdf).length : 0, raw: g.raw });
    }
    return json({ ok: false, error: `acción desconocida: ${accion}` }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e), raw: (e as any)?.raw ?? undefined }, 500);
  }
});
