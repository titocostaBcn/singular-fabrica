// fab v11 — Gestión de producción Singular Wardrobe
// Estados por prenda: (pendiente) → cortar (vinilo) → estampar → empaquetar, y sin_stock; el pedido (trigger en BD) toma el de su prenda más atrasada.
// Importación diaria 8:00 Madrid (cron fab_importar_0800). Acciones: importar · actualizar · revisar_cambios · lineas · producido · impresa · reimprimir ·
// shopify_otros · shopify_personas · soy_admin · usuarios · usuario_guardar · usuario_quitar · ventas · enviados · buscar · meta · diag · prueba_gls
// v7: recoge los cambios hechos en Shopify en pedidos ya importados (talla/prenda, cantidad, dirección, nota, envío).
// v8 (ola 1): Sin stock marcado a mano manda sobre el stock de Shopify; prendas quitadas con vinilo asignado lo devuelven al almacén;
//     Shopify (apagado hasta tener permiso de escritura): enviado en Otros envíos y metacampos estampado_por / empaquetado_por.
// v9: usuarios desde la pantalla (solo fab_usuarios.admin): alta con contraseña, contraseña nueva y quitar acceso, sin correos.
// v10: puesto por usuario (administracion, produccion, expedicion): cada una tiene su pantalla.
// v11: las prendas «sin vinilo» las revisa Producción (ya no pasan solas a Empaquetar según el stock de Shopify).
// v12: ventas por día para el panel de gerencia (acción «ventas», solo lectura de Shopify): fab_ventas_dia y fab_ventas_producto.
// v14: GLS con la documentación oficial de iClientes (13-oct): dirección ws-customer.gls-spain.es, reimpresión EtiquetaEnvioV2 con uid,
//      móvil 00+prefijo para EuroBusinessParcel; prueba_gls admite {pais:"FR"}.
// v13: «Responsable» por usuario (fab_usuarios.jefe) en la lista de usuarios: en Expedición reparte, pausa y recupera pedidos.
// Auth: JWT de usuario de la pantalla de fábrica, o cabecera x-fab-cron (vault: fab_cron_key) para la tarea programada.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding@1/base64";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = "2026-01";
// Dirección oficial desde 2025 (documentación de iClientes v1.12): la antigua wsclientes.asmred.com se sustituye por esta.
const GLS_URL = "https://ws-customer.gls-spain.es/b2b.asmx";
const GLS_UID_PRUEBAS = "6BAB7A53-3B6D-4D5A-9450-702D2FAC0B11"; // usuario público de pruebas de GLS/ASM
// Servicio nacional (96/18 BusinessParcel) solo para España: GLS confirma (13-oct) que el 96 no vale para ES→PT; Portugal va con EuroBusiness (74/3).
const NACIONAL = new Set(["ES"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-fab-cron",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ───────── utilidades ─────────
async function secret(name: string): Promise<string | null> {
  // Reintenta: el 17-oct a las 8:00 la lectura falló una vez al arrancar (devolvió vacío → 401 y no se importó)
  for (let i = 0; i < 3; i++) {
    const { data, error } = await sb.rpc("read_secret", { p_name: name });
    if (!error && data) return data as string;
    if (!error && i > 0) return null; // de verdad no existe
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  return null;
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
  const { data: abiertos } = await sb.from("fab_pedidos").select("order_id, estado")
    .is("gls_codbarras", null).eq("cancelado", false).eq("enviado_fuera", false);
  let cancelados = 0, fuera = 0, archivados = 0;
  const producidos = new Set((abiertos ?? []).filter((r) => r.estado === "producido").map((r) => Number(r.order_id)));
  const lista = (abiertos ?? []).map((r) => Number(r.order_id));
  for (let i = 0; i < lista.length; i += 100) {
    const d = await gql(`query Estado($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id cancelledAt closed displayFulfillmentStatus } } }`,
      { ids: lista.slice(i, i + 100).map(gidOrder) });
    for (const n of d.nodes ?? []) {
      if (!n) continue;
      if (n.cancelledAt) { await sb.from("fab_pedidos").update({ cancelado: true }).eq("order_id", idNum(n.id)); cancelados++; }
      else if (n.displayFulfillmentStatus === "FULFILLED") { await sb.from("fab_pedidos").update({ enviado_fuera: true }).eq("order_id", idNum(n.id)); fuera++; }
      // 21-oct (Tito): ARCHIVADO en Shopify sin marcar como preparado = se dio por terminado → sale del taller (queda constancia)
      else if (n.closed && !producidos.has(idNum(n.id))) {
        await sb.from("fab_pedidos").update({ enviado_fuera: true }).eq("order_id", idNum(n.id));
        await evento(idNum(n.id), "archivado_shopify", { fulfillment: n.displayFulfillmentStatus }, usuario); archivados++;
      }
    }
  }

  const res = { revisados: pedidos.length, nuevos, cancelados, enviados_fuera: fuera, archivados, sin_vinilo: sinVinilo, ...(sincro ? { modificados } : {}) };
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
// Desde v11 (11-oct, decisión de Tito) las prendas «sin vinilo» las revisa Producción: si hay, «✔ Preparadas» (van a la
// estantería de hechas y el programa las reparte); si no, «✖ No hay». El programa ya no las pasa solo a Empaquetar ni a Sin
// stock según el stock de Shopify. Solo devuelve a Producción las que había mandado él a Sin stock con la versión anterior.
async function repartirSinVinilo(usuario: string) {
  const { data } = await sb.from("fab_lineas").select("line_id").eq("sin_vinilo", true).eq("estado", "sin_stock").eq("estado_por", "auto sin vinilo");
  const ids = (data ?? []).map((l: any) => l.line_id);
  if (ids.length) {
    await sb.from("fab_lineas").update({ estado: "cortar", estado_at: new Date().toISOString(), estado_por: "a producción" }).in("line_id", ids);
    await evento(null, "sin_vinilo", { a_produccion: ids }, usuario);
  }
  return { disponibles: 0, sin_stock: 0, a_produccion: ids.length };
}

// ───────── GLS ─────────
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").trim();
// Prefijo telefónico por país (para el móvil de EuroBusinessParcel, que GLS pide como 00 + prefijo + número)
const PREFIJO: Record<string, string> = { ES: "34", PT: "351", FR: "33", DE: "49", IT: "39", NL: "31", BE: "32", LU: "352", AT: "43", IE: "353",
  DK: "45", SE: "46", FI: "358", PL: "48", CZ: "420", SK: "421", SI: "386", HU: "36", HR: "385", RO: "40", BG: "359", GR: "30", CY: "357",
  MT: "356", EE: "372", LV: "371", LT: "370", AD: "376" };
// Teléfono nacional (sin prefijo del país, máx. 10 cifras) y móvil internacional (00 + prefijo + número)
function telefonos(t: string | null, pais: string): { tel: string; movilIntl: string } {
  const p = PREFIJO[(pais || "ES").toUpperCase()] ?? "";
  let x = (t ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "00");
  if (p && x.startsWith("00" + p)) x = x.slice(2 + p.length);
  else if (x.startsWith("00")) return { tel: "", movilIntl: x };      // número de otro país: se manda tal cual en el móvil
  const nac = x.replace(/^0+/, "");
  return { tel: x.slice(-10), movilIntl: p && nac ? "00" + p + nac : "" };
}
function telefono(t: string | null): string { return telefonos(t, "ES").tel; }

async function glsGrabar(p: any, cfg: Record<string, string>, metodo: "GrabaServicios" | "ValidaEuroBusiness" = "GrabaServicios") {
  const modo = cfg.gls_modo === "real" ? "real" : "pruebas";
  const uid = modo === "real" ? await secret("gls_uid_cliente") : GLS_UID_PRUEBAS;
  if (!uid) throw new Error("Falta el UID de cliente GLS en el vault (gls_uid_cliente)");
  const nac = NACIONAL.has((p.pais ?? "ES").toUpperCase());
  // Baleares (CP 07…): EconomyParcel 37/18, según GLS (23-oct). Península: BusinessParcel 96/18. Portugal y resto UE: EuroBusinessParcel 74/3.
  const baleares = nac && (/^07/.test(String(p.cp ?? "").trim()) || /balear|illes/i.test(String(p.provincia ?? "")));
  const servicio = baleares ? (cfg.gls_servicio_baleares ?? "37") : nac ? cfg.gls_servicio_nacional : cfg.gls_servicio_internacional;
  const horario = baleares ? (cfg.gls_horario_baleares ?? "18") : nac ? cfg.gls_horario_nacional : cfg.gls_horario_internacional;
  const ref = String(p.order_name).replace(/[^0-9A-Za-z-]/g, "").slice(0, 15);
  const { tel, movilIntl } = telefonos(p.telefono, p.pais ?? "ES");
  const movil = nac ? tel : movilIntl;
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
      <Movil>${esc(movil)}</Movil>
      <Email>${esc(p.email)}</Email>
      <Observaciones></Observaciones>
    </Destinatario>
    <Referencias><Referencia tipo="C">${esc(ref)}</Referencia></Referencias>
    <DevuelveAdicionales><Etiqueta tipo="PDF" /></DevuelveAdicionales>
  </Envio>
</Servicios>`;

  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
<soap12:Body><${metodo} xmlns="http://www.asmred.com/"><docIn>${docIn}</docIn></${metodo}></soap12:Body></soap12:Envelope>`;

  const r = await fetch(GLS_URL, { method: "POST", headers: { "Content-Type": "application/soap+xml; charset=utf-8" }, body });
  const xml = await r.text();
  // ValidaEuroBusiness solo valida los datos (no crea envío): devuelve <Resultado return="0" result="E000" /> si todo está bien
  if (metodo !== "GrabaServicios") { const x = xml.replace(/&lt;/g, "<").replace(/&gt;/g, ">"); return { modo, http: r.status, resultado: x.match(/<Resultado[^>]*>/)?.[0] ?? null, respuesta: x.replace(/^[\s\S]*?<soap:Body>/, "").slice(0, 900) } as any; }
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

// Reimpresión: EtiquetaEnvioV2 (pide el uid del cliente; el modo es el del envío: pruebas o real)
async function glsEtiquetaEnvio(codigo: string, modo: string | null): Promise<string | null> {
  const uid = modo === "real" ? await secret("gls_uid_cliente") : GLS_UID_PRUEBAS;
  if (!uid) throw new Error("Falta el UID de cliente GLS en el vault (gls_uid_cliente)");
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>
<EtiquetaEnvioV2 xmlns="http://www.asmred.com/"><uidcliente>${esc(uid)}</uidcliente><codigo>${esc(codigo)}</codigo><tipoEtiqueta>PDF</tipoEtiqueta></EtiquetaEnvioV2>
</soap12:Body></soap12:Envelope>`;
  const r = await fetch(GLS_URL, { method: "POST", headers: { "Content-Type": "application/soap+xml; charset=utf-8" }, body });
  const xml = await r.text();
  glsUltimaReimpresion = xml.replace(/>[A-Za-z0-9+\/=\s]{200,}</g, ">[base64]<").slice(0, 1500);
  // EtiquetaEnvioV2 devuelve <Etiquetas><Etiqueta>base64</Etiqueta></Etiquetas> (la versión antigua, <base64Binary>)
  return xml.match(/<(?:Etiqueta|base64Binary)\b[^>]*>([A-Za-z0-9+\/=\s]+)<\/(?:Etiqueta|base64Binary)>/)?.[1]?.replace(/\s/g, "") ?? null;
}
let glsUltimaReimpresion = "";

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
// ¿Ya salió desde otro sitio (app de GLS de Shopify, a mano)? Devuelve el envío de Shopify si lo hay.
// Si Shopify no responde, devuelve null y se sigue con GLS como siempre.
async function shopifyYaEnviado(order_id: number) {
  try {
    const d = await gql(`query YaEnv($id: ID!) { order(id: $id) { fulfillments { id status createdAt trackingInfo { company number } } } }`, { id: gidOrder(order_id) });
    const f = (d.order?.fulfillments ?? []).filter((x: any) => x.status === "SUCCESS").sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!f) return null;
    const tr = (f.trackingInfo ?? []).find((x: any) => x.number) ?? null;
    return { fid: f.id as string, numero: (tr?.number ?? null) as string | null, empresa: (tr?.company ?? "") as string };
  } catch { return null; }
}
// El pedido ya tiene envío en Shopify: se apunta su seguimiento y NO se pide otra etiqueta a GLS (evita duplicados).
async function marcarYaEnviado(order_id: number, ya: { fid: string; numero: string | null; empresa: string }, usuario: string) {
  const esGls = !!ya.numero && /gls/i.test(ya.empresa || "GLS");
  await sb.from("fab_pedidos").update({
    gls_uid: null, gls_error: null, shopify_error: null, shopify_fulfillment_id: ya.fid,
    ...(esGls ? { gls_codbarras: ya.numero, gls_modo: "real" } : { envio_tipo: "otros", envio_info: [ya.empresa, ya.numero].filter(Boolean).join(" ") || "Enviado desde Shopify" }),
    etiqueta_impresa: true, etiqueta_impresa_at: new Date().toISOString(),
  }).eq("order_id", order_id);
  await evento(order_id, "gls_app_shopify", { codbarras: ya.numero, empresa: ya.empresa, fulfillment: ya.fid }, usuario);
  const n = ya.numero ? ` (${ya.empresa ? ya.empresa.replace(/,? ?S\.A\.?$/i, "") + " " : ""}${ya.numero})` : "";
  return { ok: true, ya_enviado: true, codbarras: ya.numero, aviso: `Este pedido ya estaba enviado desde Shopify${n}: no se ha hecho otra etiqueta.` };
}

// Error de GLS explicado para el taller (lo que sale en la tarjeta y en el aviso)
function glsConsejo(msg: string, p: any): string {
  if (/return=-69|canalizar/i.test(msg)) return `GLS no reconoce la dirección: revisa que el código postal ${p.cp ?? ""} corresponde a ${p.ciudad ?? "la población"}. Corrígelo en Shopify, pulsa «🔄 Actualizar desde Shopify» y vuelve a pulsar la salida. (${msg})`;
  return msg;
}
// Si GLS falla, el pedido VUELVE a Empaquetar (con el error a la vista) para corregir y reintentar; antes se quedaba atascado en producido sin etiqueta.
async function volverAEmpaquetar(order_id: number, msg: string, asignado: string | null) {
  await sb.from("fab_pedidos").update({ estado: "empaquetar", estado_at: new Date().toISOString(), gls_uid: null, gls_error: msg, asignado_a: asignado })
    .eq("order_id", order_id).is("gls_codbarras", null);
}

async function producido(order_id: number, usuario: string) {
  const cfg = await config();
  const { data: dest } = await sb.from("fab_pedidos").select("direccion1, pais, cp, provincia, asignado_a").eq("order_id", order_id).maybeSingle();
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
    // Antes de pedir etiqueta: si ya salió desde la app de GLS de Shopify, no se duplica
    const ya = await shopifyYaEnviado(order_id);
    if (ya) return await marcarYaEnviado(order_id, ya, usuario);
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
      // «Ya existe el albarán»: GLS ya tiene un envío con este nº de pedido (normalmente de la app de GLS de Shopify)
      if (/ya existe el albar/i.test(String((e as Error).message))) {
        const ya2 = await shopifyYaEnviado(order_id);
        if (ya2) return await marcarYaEnviado(order_id, ya2, usuario);
        await volverAEmpaquetar(order_id, String((e as Error).message), dest?.asignado_a ?? null);
        await evento(order_id, "gls_error", { error: String((e as Error).message), raw: (e as any).raw ?? null }, usuario);
        return { ok: false, error: "GLS dice que ya hay un envío con este número de pedido (¿se hizo la etiqueta desde la app de GLS?). No hagas otra: avisa a Tito." };
      }
      const msg = glsConsejo(String((e as Error).message), lock);
      await volverAEmpaquetar(order_id, msg, dest?.asignado_a ?? null);
      await evento(order_id, "gls_error", { error: String((e as Error).message), raw: (e as any).raw ?? null }, usuario);
      return { ok: false, error: `GLS: ${msg}` };
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
  return p.gls_codbarras ? await glsEtiquetaEnvio(p.gls_codbarras, p.gls_modo) : null;
}

// ───────── Ventas por día (panel de gerencia) ─────────
// Lee de Shopify los pedidos creados entre dos días (hora de Madrid) y rehace esos días en fab_ventas_dia y fab_ventas_producto.
// Solo lectura en Shopify. Sin pedidos de prueba; los cancelados se cuentan aparte y no suman venta.
const Q_VENTAS = `query Ventas($q: String!, $after: String) { orders(first: 30, after: $after, query: $q, sortKey: CREATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes { id createdAt cancelledAt test customer { id orders(first: 1, sortKey: CREATED_AT) { nodes { id } } }
    totalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } } totalDiscountsSet { shopMoney { amount } }
    lineItems(first: 20) { nodes { title quantity discountedTotalSet { shopMoney { amount } } } } } } }`;
const diaMadrid = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid" }).format(new Date(iso));
const sumarDia = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
// Desfase de Madrid respecto a UTC en un día concreto («+01:00» o «+02:00»)
function desfaseMadrid(d: string) {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(new Date(d + "T12:00:00Z")));
  return `+0${h - 12}:00`;
}
async function gqlReintento(query: string, vars: Record<string, unknown>) {
  for (let i = 0; ; i++) {
    try { return await gql(query, vars); }
    catch (e) { if (i >= 4 || !/THROTTLED|throttl|429|50\d/i.test(String((e as Error).message))) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
  }
}
async function sincronizarVentas(desde: string, hasta: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || desde > hasta) throw new Error("fechas no válidas");
  const fin = sumarDia(hasta, 1);
  const q = `created_at:>='${desde}T00:00:00${desfaseMadrid(desde)}' created_at:<'${fin}T00:00:00${desfaseMadrid(fin)}'`;
  const dias = new Map<string, any>(), prods = new Map<string, any>();
  for (let d = desde; d <= hasta; d = sumarDia(d, 1)) dias.set(d, { dia: d, pedidos: 0, unidades: 0, total: 0, devuelto: 0, envio: 0, iva: 0, descuentos: 0, cancelados: 0, enviados: 0, pedidos_nuevos: 0, pedidos_recurrentes: 0, ventas_nuevos: 0, ventas_recurrentes: 0 });
  const num = (m: any) => Number(m?.shopMoney?.amount ?? 0);
  let after: string | null = null, leidos = 0;
  do {
    const r: any = await gqlReintento(Q_VENTAS, { q, after });
    for (const o of r.orders.nodes) {
      if (o.test) continue;
      const v = dias.get(diaMadrid(o.createdAt)); if (!v) continue;
      leidos++;
      // Como Shopify («Ventas totales»): el pedido cuenta el día que se hizo, también si luego se cancela;
      // las devoluciones y cancelaciones reembolsadas se restan el día en que se devuelve el dinero (segunda consulta).
      if (o.cancelledAt) v.cancelados++;
      v.pedidos++; v.total += num(o.totalPriceSet);
      v.envio += num(o.totalShippingPriceSet); v.iva += num(o.totalTaxSet); v.descuentos += num(o.totalDiscountsSet);
      // Clienta nueva = es su primer pedido en la tienda (sin cliente asociado cuenta como nueva)
      const primero = o.customer?.orders?.nodes?.[0]?.id;
      const venta = num(o.totalPriceSet);
      if (!o.customer || !primero || primero === o.id) { v.pedidos_nuevos++; v.ventas_nuevos += venta; } else { v.pedidos_recurrentes++; v.ventas_recurrentes += venta; }
      for (const li of o.lineItems.nodes) {
        v.unidades += li.quantity;
        const k = v.dia + "|" + li.title;
        const p = prods.get(k) ?? { dia: v.dia, titulo: li.title, unidades: 0, importe: 0 };
        p.unidades += li.quantity; p.importe += num(li.discountedTotalSet); prods.set(k, p);
      }
    }
    after = r.orders.pageInfo.hasNextPage ? r.orders.pageInfo.endCursor : null;
  } while (after);
  // Devoluciones por fecha de reembolso (de pedidos de cualquier día), como hace Shopify
  const desdeTz = `${desde}T00:00:00${desfaseMadrid(desde)}`;
  const q2 = `(financial_status:refunded OR financial_status:partially_refunded) updated_at:>='${desdeTz}'`;
  let after2: string | null = null, reembolsos = 0;
  do {
    const r: any = await gqlReintento(`query Reemb($q: String!, $after: String) { orders(first: 100, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor } nodes { test refunds { createdAt totalRefundedSet { shopMoney { amount } } } } } }`, { q: q2, after: after2 });
    for (const o of r.orders.nodes) {
      if (o.test) continue;
      for (const rf of o.refunds ?? []) {
        const v = dias.get(diaMadrid(rf.createdAt)); if (!v) continue;
        v.devuelto += num(rf.totalRefundedSet); reembolsos++;
      }
    }
    after2 = r.orders.pageInfo.hasNextPage ? r.orders.pageInfo.endCursor : null;
  } while (after2);
  // Pedidos enviados (preparados) por día: el día de su primer envío en Shopify
  const env = await contarEnviados(desde, hasta);
  for (const [d, n] of env) { const v = dias.get(d); if (v) v.enviados = n; }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const filas = [...dias.values()].map((v) => ({ ...v, total: r2(v.total), devuelto: r2(v.devuelto), envio: r2(v.envio), iva: r2(v.iva), descuentos: r2(v.descuentos), ventas_nuevos: r2(v.ventas_nuevos), ventas_recurrentes: r2(v.ventas_recurrentes), actualizado_at: new Date().toISOString() }));
  const { error: e1 } = await sb.from("fab_ventas_dia").upsert(filas, { onConflict: "dia" });
  if (e1) throw new Error("ventas: " + e1.message);
  const { error: e2 } = await sb.from("fab_ventas_producto").delete().gte("dia", desde).lte("dia", hasta);
  if (e2) throw new Error("ventas productos: " + e2.message);
  const lp = [...prods.values()].map((p) => ({ ...p, importe: r2(p.importe) }));
  for (let i = 0; i < lp.length; i += 1000) {
    const { error } = await sb.from("fab_ventas_producto").insert(lp.slice(i, i + 1000));
    if (error) throw new Error("ventas productos: " + error.message);
  }
  return { desde, hasta, dias: filas.length, pedidos: filas.reduce((s, f) => s + f.pedidos, 0), leidos, reembolsos, productos: lp.length };
}

// Pedidos enviados por día (= «preparados»): cuenta cada pedido el día de su PRIMER envío (fulfillment) en Shopify,
// esté enviado entero o en parte; no cuenta envíos cancelados ni pedidos de prueba. Busca entre los pedidos creados
// hasta 120 días antes del rango (un pedido no tarda más en salir). Solo lectura.
async function contarEnviados(desde: string, hasta: string) {
  const ini = sumarDia(desde, -120), fin = sumarDia(hasta, 1);
  // Rango reciente (lo normal: sincronización diaria o del panel): basta con los pedidos tocados desde «desde»
  // (enviar un pedido lo modifica), que son pocos. Para el histórico, por fecha de creación (hasta 120 días antes).
  const reciente = desde >= sumarDia(diaMadrid(new Date().toISOString()), -10);
  const q = reciente
    ? `(fulfillment_status:shipped OR fulfillment_status:partial) updated_at:>='${desde}T00:00:00${desfaseMadrid(desde)}'`
    : `(fulfillment_status:shipped OR fulfillment_status:partial) created_at:>='${ini}T00:00:00${desfaseMadrid(ini)}' created_at:<'${fin}T00:00:00${desfaseMadrid(fin)}'`;
  const cuenta = new Map<string, number>();
  let after: string | null = null;
  do {
    const r: any = await gqlReintento(`query Env($q: String!, $after: String) { orders(first: 100, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor } nodes { test createdAt closedAt fulfillments(first: 10) { createdAt status } } } }`, { q, after });
    for (const o of r.orders.nodes) {
      if (o.test) continue;
      const fs = (o.fulfillments ?? []).filter((f: any) => f.status !== "CANCELLED" && f.status !== "ERROR" && f.status !== "FAILURE").map((f: any) => f.createdAt).sort();
      if (!fs.length) continue;
      // 21-oct: regularizaciones (pedido ARCHIVADO antes de marcarlo preparado, p. ej. los 1.178 antiguos marcados de golpe)
      // o pedidos de hace más de 120 días no son envíos de ese día
      if (o.closedAt && o.closedAt < fs[0]) continue;
      if (o.createdAt && new Date(fs[0]).getTime() - new Date(o.createdAt).getTime() > 120 * 864e5) continue;
      const d = diaMadrid(fs[0]);
      if (d >= desde && d <= hasta) cuenta.set(d, (cuenta.get(d) ?? 0) + 1);
    }
    after = r.orders.pageInfo.hasNextPage ? r.orders.pageInfo.endCursor : null;
  } while (after);
  return cuenta;
}

// Inversión en Meta Ads por día → fab_meta_dia. Windsor.ai (vault windsor_api_key) o la API de Meta (vault meta_token + meta_cuenta).
// Sin clave en el vault no hace nada (el histórico se cargó aparte) y lo dice en la respuesta.
async function sincronizarMeta(desde: string, hasta: string) {
  const r2 = (x: number) => Math.round(Number(x || 0) * 100) / 100;
  let filas: any[] = [];
  const wk = await secret("windsor_api_key");
  if (wk) {
    const u = `https://connectors.windsor.ai/facebook?api_key=${encodeURIComponent(wk)}&date_from=${desde}&date_to=${hasta}&fields=date,spend,impressions,clicks,actions_purchase,action_values_purchase`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Windsor ${r.status}`);
    const j = await r.json();
    const por = new Map<string, any>();
    for (const x of (j.data ?? [])) {
      const f = por.get(x.date) ?? { dia: x.date, gasto: 0, impresiones: 0, clics: 0, compras: 0, valor_compras: 0 };
      f.gasto += Number(x.spend || 0); f.impresiones += Number(x.impressions || 0); f.clics += Number(x.clicks || 0);
      f.compras += Number(x.actions_purchase || 0); f.valor_compras += Number(x.action_values_purchase || 0); por.set(x.date, f);
    }
    filas = [...por.values()];
  } else {
    const tk = await secret("meta_token"), cuenta = await secret("meta_cuenta");
    if (!tk || !cuenta) return { omitido: "sin clave de Windsor ni de Meta en el vault" };
    let url: string | null = `https://graph.facebook.com/v21.0/act_${cuenta}/insights?level=account&time_increment=1&fields=spend,impressions,clicks,actions,action_values`
      + `&time_range=${encodeURIComponent(JSON.stringify({ since: desde, until: hasta }))}&access_token=${encodeURIComponent(tk)}`;
    while (url) {
      const r = await fetch(url); const j = await r.json();
      if (j.error) throw new Error(`Meta: ${j.error.message}`);
      for (const x of j.data ?? []) {
        const compra = (l: any[]) => Number((l ?? []).find((a: any) => a.action_type === "purchase" || a.action_type === "omni_purchase")?.value ?? 0);
        filas.push({ dia: x.date_start, gasto: Number(x.spend || 0), impresiones: Number(x.impressions || 0), clics: Number(x.clicks || 0), compras: compra(x.actions), valor_compras: compra(x.action_values) });
      }
      url = j.paging?.next ?? null;
    }
  }
  const out = filas.map((f) => ({ ...f, gasto: r2(f.gasto), valor_compras: r2(f.valor_compras), compras: Math.round(f.compras), actualizado_at: new Date().toISOString() }));
  if (out.length) { const { error } = await sb.from("fab_meta_dia").upsert(out, { onConflict: "dia" }); if (error) throw new Error("meta: " + error.message); }
  return { dias: out.length, gasto: r2(out.reduce((s, f) => s + f.gasto, 0)) };
}

// Puestos (fab_usuarios.puesto): deciden la pantalla de cada persona. Sin puesto = administración (todo).
const PUESTOS = ["administracion", "produccion", "expedicion"];

// Usuarios de Auth por email (todas las páginas; este Supabase también tiene usuarios de otras aplicaciones)
async function usuariosAuth() {
  const m = new Map<string, any>();
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) if (u.email) m.set(u.email.toLowerCase(), u);
    if (data.users.length < 1000) break;
  }
  return m;
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
      // Antes de esa hora no hace nada; a esa hora importa; MÁS TARDE solo importa si hoy aún no hay ninguna importación buena
      // (red de seguridad: el cron llama también una y dos horas después por si la de las 8 falló)
      if (usuario === "cron" && hora && horaMadrid() !== Number(hora)) {
        if (horaMadrid() < Number(hora)) return json({ ok: true, omitido: `no son las ${hora} en Madrid` });
        const hoy0 = `${diaMadrid(new Date().toISOString())}T00:00:00${desfaseMadrid(diaMadrid(new Date().toISOString()))}`;
        const { count } = await sb.from("fab_eventos").select("tipo", { count: "exact", head: true }).eq("tipo", "importacion").gte("created_at", hoy0);
        if ((count ?? 0) > 0) return json({ ok: true, omitido: "ya importado hoy" });
      }
      try {
        const res = await importar(usuario);
        let ventas: unknown = null;
        // La tarea de la mañana rehace 7 días; el botón de la pantalla, solo ayer y hoy (rápido: el móvil no espera minutos)
        // ?rapido=1 = importación de cada hora (21-oct, para que los exprés del día salgan sin esperar a mañana): también solo ayer y hoy
        const diasAtras = usuario === "cron" && url.searchParams.get("rapido") !== "1" ? 7 : 1;
        try { const hoy = diaMadrid(new Date().toISOString()); ventas = await sincronizarVentas(sumarDia(hoy, -diasAtras), hoy); }
        catch (e) { ventas = { error: String((e as Error).message ?? e) }; await evento(null, "ventas_error", ventas, usuario); }
        let meta: unknown = null;
        try { const hoy = diaMadrid(new Date().toISOString()); meta = await sincronizarMeta(sumarDia(hoy, -diasAtras), hoy); }
        catch (e) { meta = { error: String((e as Error).message ?? e) }; await evento(null, "meta_error", meta, usuario); }
        return json({ ok: true, ...res, ventas, meta });
      } catch (e) {
        // Queda registrado: la pantalla muestra "ERROR no actualizado hoy" si no hay importación correcta del día
        await evento(null, "importacion_error", { error: String((e as Error).message ?? e) }, usuario);
        throw e;
      }
    }

    if (accion === "ventas") {
      // Panel de gerencia: solo la tarea programada o Administración (sin puesto o administracion, o admin)
      if (usuario !== "cron") {
        const { data: yo } = await sb.from("fab_usuarios").select("admin, puesto").eq("email", usuario.toLowerCase()).maybeSingle();
        if (!yo || !(yo.admin || !yo.puesto || yo.puesto === "administracion")) return json({ ok: false, error: "Solo Administración" }, 403);
      }
      const hoy = diaMadrid(new Date().toISOString());
      const desde = String(body.desde ?? hoy), hasta = String(body.hasta ?? hoy);
      if (usuario !== "cron" && (desde < sumarDia(hoy, -31))) return json({ ok: false, error: "Desde la pantalla solo se pueden refrescar los últimos 31 días" }, 400);
      const res = await sincronizarVentas(desde, hasta);
      let meta: unknown = null;
      try { meta = await sincronizarMeta(desde, hasta); } catch (e) { meta = { error: String((e as Error).message ?? e) }; }
      return json({ ok: true, ...res, meta });
    }

    if (accion === "prueba_shopifyql") {
      if (usuario !== "cron") return json({ ok: false, error: "no autorizado" }, 403);
      try {
        const d = await gql(`query Q($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name dataType } rows } parseErrors } }`, { q: String(body.q ?? "FROM sales SHOW total_sales SINCE -1d UNTIL today") });
        return json({ ok: true, d });
      } catch (e) { return json({ ok: false, error: String((e as Error).message) }); }
    }
    if (accion === "enviados") {
      // Solo la tarea programada: rellena fab_ventas_dia.enviados de un rango (histórico), sin tocar el resto de columnas
      if (usuario !== "cron") return json({ ok: false, error: "no autorizado" }, 403);
      const desde = String(body.desde), hasta = String(body.hasta);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta) || desde > hasta) return json({ ok: false, error: "fechas no válidas" }, 400);
      const env = await contarEnviados(desde, hasta);
      let total = 0, dias = 0;
      for (let d = desde; d <= hasta; d = sumarDia(d, 1)) {
        const n = env.get(d) ?? 0; total += n;
        const { data } = await sb.from("fab_ventas_dia").update({ enviados: n }).eq("dia", d).select("dia");
        if (data?.length) dias++;
      }
      return json({ ok: true, desde, hasta, enviados: total, dias });
    }
    if (accion === "meta") {
      // Solo la tarea programada: rehace la inversión en Meta Ads de un rango (para cargar el histórico)
      if (usuario !== "cron") return json({ ok: false, error: "no autorizado" }, 403);
      const hoy = diaMadrid(new Date().toISOString());
      return json({ ok: true, ...(await sincronizarMeta(String(body.desde ?? sumarDia(hoy, -7)), String(body.hasta ?? hoy))) });
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
    if (accion === "buscar") {
      // Buscador de pedidos para todas las pantallas (18-oct, pedido de Tito): por nº de pedido, nombre o email.
      // Shopify (solo lectura) da el pedido, la clienta y cuántos pedidos lleva; el taller añade en qué punto está.
      const q = String(body.q ?? "").trim().slice(0, 80);
      if (q.length < 2) return json({ ok: false, error: "Escribe al menos 2 letras o el número del pedido" }, 400);
      const num = q.replace(/^#/, "");
      const busq = /^\d{3,7}$/.test(num) ? `name:#${num} OR name:${num}` : q.replace(/["\\]/g, " ");
      const d: any = await gqlReintento(`query Buscar($q: String!) { orders(first: 15, query: $q, sortKey: CREATED_AT, reverse: true) { nodes {
        id name createdAt cancelledAt closedAt displayFinancialStatus displayFulfillmentStatus note tags test
        totalPriceSet { shopMoney { amount } } shippingLine { title }
        shippingAddress { name address1 address2 zip city province country phone }
        customer { displayName email phone numberOfOrders amountSpent { amount } }
        lineItems(first: 30) { nodes { title variantTitle quantity customAttributes { key value } } }
        fulfillments(first: 5) { createdAt status trackingInfo { company number url } } } } }`, { q: busq });
      const nodos = (d.orders?.nodes ?? []).filter((o: any) => !o.test);
      const ids = nodos.map((o: any) => Number(String(o.id).split("/").pop()));
      const { data: taller } = ids.length ? await sb.from("fab_pedidos").select("order_id, estado, estado_at, asignado_a, gls_codbarras, gls_modo, envio_tipo, envio_info, entregado_at, enviado_fuera, direccion1, cancelado, empaquetado_por, empaquetado_at, fab_lineas(titulo, variante, cantidad, estado, personalizacion)").in("order_id", ids) : { data: [] };
      const porId = new Map((taller ?? []).map((t: any) => [Number(t.order_id), t]));
      const pedidos = nodos.map((o: any) => {
        const id = Number(String(o.id).split("/").pop());
        return { id, nombre: o.name, fecha: o.createdAt, cancelado: o.cancelledAt, archivado: o.closedAt, pago: o.displayFinancialStatus, envio: o.displayFulfillmentStatus,
          nota: o.note, etiquetas: o.tags, total: Number(o.totalPriceSet?.shopMoney?.amount ?? 0), metodo: o.shippingLine?.title ?? null,
          direccion: o.shippingAddress, clienta: o.customer ? { nombre: o.customer.displayName, email: o.customer.email, telefono: o.customer.phone, pedidos: Number(o.customer.numberOfOrders ?? 0), gastado: Number(o.customer.amountSpent?.amount ?? 0) } : null,
          prendas: o.lineItems.nodes.map((l: any) => ({ titulo: l.title, variante: l.variantTitle, cantidad: l.quantity, extra: (l.customAttributes ?? []).filter((a: any) => a.value && !a.key.startsWith("_")) })),
          envios: (o.fulfillments ?? []).filter((f: any) => f.status !== "CANCELLED").map((f: any) => ({ fecha: f.createdAt, seguimiento: (f.trackingInfo ?? []).map((t: any) => ({ empresa: t.company, numero: t.number, url: t.url })) })),
          taller: porId.get(id) ?? null };
      });
      return json({ ok: true, q, pedidos });
    }
    if (accion === "reimprimir") {
      const { data: p } = await sb.from("fab_pedidos").select().eq("order_id", order_id).single();
      const pdf = await pdfDe(p);
      await evento(order_id, "reimpresion", { ok: !!pdf }, usuario);
      return json({ ok: !!pdf, pdf, error: pdf ? undefined : "No se pudo recuperar la etiqueta" });
    }
    // ───── usuarios (solo administradores, fab_usuarios.admin): alta, contraseña y quitar acceso, sin correos ─────
    if (accion === "soy_admin" || accion === "usuarios" || accion === "usuario_guardar" || accion === "usuario_quitar") {
      const yo = usuario === "cron" ? null : (await sb.from("fab_usuarios").select("email, admin").eq("email", usuario.toLowerCase()).maybeSingle()).data;
      if (accion === "soy_admin") return json({ ok: true, admin: !!yo?.admin });
      if (!yo?.admin) return json({ ok: false, error: "Solo un administrador puede gestionar usuarios" }, 403);
      if (accion === "usuarios") {
        const { data: filas, error } = await sb.from("fab_usuarios").select("email, nombre, admin, puesto, jefe, creado_at").order("creado_at");
        if (error) throw error;
        const auth = await usuariosAuth();
        return json({ ok: true, yo: usuario.toLowerCase(), usuarios: (filas ?? []).map((f: any) => {
          const u = auth.get(String(f.email).toLowerCase());
          return { email: f.email, nombre: f.nombre, admin: !!f.admin, puesto: f.puesto ?? null, jefe: !!f.jefe, tiene_clave: !!u, ultimo_acceso: u?.last_sign_in_at ?? null };
        }) });
      }
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "El email no es válido" }, 400);
      const { data: fila } = await sb.from("fab_usuarios").select("email, admin").eq("email", email).maybeSingle();
      if (accion === "usuario_quitar") {
        if (!fila) return json({ ok: true, aviso: "Ya no tenía acceso" });
        if (email === usuario.toLowerCase()) return json({ ok: false, error: "No puedes quitarte el acceso a ti mismo" }, 400);
        if (fila.admin) return json({ ok: false, error: "No se puede quitar el acceso a un administrador desde aquí" }, 400);
        const { error } = await sb.from("fab_usuarios").delete().eq("email", email);
        if (error) throw error;
        await evento(null, "usuario", { accion: "quitar", email }, usuario);
        return json({ ok: true });
      }
      // usuario_guardar: alta (con contraseña) o contraseña nueva. La contraseña no se guarda ni se registra en ningún sitio.
      const clave = String(body.clave ?? "");
      const nombre = body.nombre === undefined ? undefined : (String(body.nombre).trim() || null);
      if (clave && clave.length < 8) return json({ ok: false, error: "La contraseña tiene que tener al menos 8 caracteres" }, 400);
      // Puesto: decide su pantalla (administracion = todo; produccion y expedicion = pantalla sencilla). Sin puesto = todo.
      let puesto: string | null | undefined;
      if (body.puesto !== undefined) {
        puesto = body.puesto === null || body.puesto === "" ? null : String(body.puesto);
        if (puesto !== null && !PUESTOS.includes(puesto)) return json({ ok: false, error: "Puesto no válido" }, 400);
      }
      // Responsable (fab_usuarios.jefe): la responsable de su puesto. En Expedición reparte, pausa y recupera pedidos.
      const jefe = body.jefe === undefined ? undefined : !!body.jefe;
      const u = (await usuariosAuth()).get(email);
      let hecho = "";
      if (!u) {
        if (!clave) return json({ ok: false, error: "Pon una contraseña para el usuario nuevo" }, 400);
        const { error } = await sb.auth.admin.createUser({ email, password: clave, email_confirm: true, user_metadata: { nombre: nombre ?? null, alta: "fabrica" } });
        if (error) throw error;
        hecho = "alta";
      } else if (clave) {
        // Este Supabase tiene usuarios de otras aplicaciones (TDP): solo se cambia la contraseña de quien ya es de la fábrica.
        if (!fila && u.user_metadata?.alta !== "fabrica") return json({ ok: false, error: "Ese email ya tiene usuario en otra aplicación. No se le cambia la contraseña desde aquí: añádelo sin contraseña y entrará con la suya de siempre." }, 409);
        const { error } = await sb.auth.admin.updateUserById(u.id, { password: clave });
        if (error) throw error;
        hecho = "contraseña";
      } else {
        hecho = fila ? "datos" : "acceso";
      }
      if (!fila) {
        const { error } = await sb.from("fab_usuarios").insert({ email, nombre: nombre ?? null, puesto: puesto ?? null, jefe: jefe ?? false });
        if (error) throw error;
      } else if (nombre !== undefined || puesto !== undefined || jefe !== undefined) {
        const { error } = await sb.from("fab_usuarios").update({ ...(nombre !== undefined ? { nombre } : {}), ...(puesto !== undefined ? { puesto } : {}), ...(jefe !== undefined ? { jefe } : {}) }).eq("email", email);
        if (error) throw error;
      }
      await evento(null, "usuario", { accion: hecho, email, ...(puesto !== undefined ? { puesto } : {}), ...(jefe !== undefined ? { responsable: jefe } : {}) }, usuario);
      return json({ ok: true, hecho });
    }
    if (accion === "diag") {
      const d = await gql(`query { currentAppInstallation { accessScopes { handle } } }`);
      return json({ ok: true, usuario, scopes: d.currentAppInstallation.accessScopes.map((s: any) => s.handle), gls_uid_real: !!(await secret("gls_uid_cliente")), config: await config() });
    }
    if (accion === "consulta_uid_gls") {
      // Solo cron. Consulta de SOLO LECTURA (GetExpCli: envíos por referencia de cliente) con el UID real, el de pruebas y uno inventado,
      // para ver si GLS reconoce el UID real. No crea ni cambia nada en GLS.
      if (usuario !== "cron") return json({ ok: false, error: "Solo con la clave de la tarea programada" }, 403);
      const ref = String(body.ref ?? "38693");
      const prueba = async (uid: string | null) => {
        if (!uid) return "sin uid";
        const b = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><GetExpCli xmlns="http://www.asmred.com/"><codigo>${esc(ref)}</codigo><uid>${esc(uid)}</uid></GetExpCli></soap12:Body></soap12:Envelope>`;
        const r = await fetch(GLS_URL, { method: "POST", headers: { "Content-Type": "application/soap+xml; charset=utf-8" }, body: b });
        return `${r.status} ` + (await r.text()).replace(/^[\s\S]*?<soap:Body>/, "").slice(0, 500);
      };
      return json({ ok: true, real: await prueba(await secret("gls_uid_cliente")), pruebas: await prueba(GLS_UID_PRUEBAS), inventado: await prueba("00000000-0000-0000-0000-000000000000") });
    }
    if (accion === "valida_uid_gls") {
      // Solo cron. Comprueba el UID real (vault gls_uid_cliente) con ValidaEuroBusiness: GLS valida los datos SIN crear ningún envío.
      if (usuario !== "cron") return json({ ok: false, error: "Solo con la clave de la tarea programada" }, 403);
      const cfg = await config();
      const dest = { cliente_nombre: "Test Singular", direccion1: "10 Rue de Rivoli", ciudad: "Paris", provincia: "Paris", cp: "75001", pais: String(body.pais ?? "FR").toUpperCase(), telefono: "+33 6 12 34 56 78" };
      const v = await glsGrabar({ order_name: "VALIDA" + Date.now().toString().slice(-8), ...dest, email: "hola@singularwardrobe.com", bultos: 1, peso_kg: 1 }, { ...cfg, gls_modo: body.con_uid_pruebas ? "pruebas" : "real" }, "ValidaEuroBusiness");
      return json({ ok: true, ...v });
    }
    if (accion === "prueba_gls") {
      // Graba un envío de prueba en el entorno de pruebas de GLS (no genera envío real)
      // body.pais = "FR" prueba EuroBusinessParcel (internacional); también prueba la reimpresión (EtiquetaEnvioV2)
      const cfg = await config();
      const destinos: Record<string, any> = {
        ES: { cliente_nombre: "Prueba Singular", direccion1: "Calle Mayor 1", ciudad: "Madrid", provincia: "Madrid", cp: "28013", pais: "ES", telefono: "600000000" },
        FR: { cliente_nombre: "Test Singular", direccion1: "10 Rue de Rivoli", ciudad: "Paris", provincia: "Paris", cp: "75001", pais: "FR", telefono: "+33 6 12 34 56 78" },
        BAL: { cliente_nombre: "Prueba Singular", direccion1: "Carrer Major 1", ciudad: "Llucmajor", provincia: "Balears", cp: "07620", pais: "ES", telefono: "600000000" },
        PT: { cliente_nombre: "Teste Singular", direccion1: "Rua Augusta 100", ciudad: "Lisboa", provincia: "Lisboa", cp: "1100-053", pais: "PT", telefono: "+351 912 345 678" },
      };
      const dest = destinos[String(body.pais ?? "ES").toUpperCase()] ?? destinos.ES;
      // body.real = true (solo cron): UN envío REAL con el UID de producción, a Singular en el propio taller, para anularlo después en el Extranet
      const real = body.real === true && usuario === "cron";
      const destReal = { cliente_nombre: "Tito Costa (PRUEBA - ANULAR)", direccion1: cfg.remite_direccion, ciudad: cfg.remite_poblacion, provincia: cfg.remite_provincia, cp: cfg.remite_cp, pais: "ES", telefono: cfg.remite_telefono };
      const g = await glsGrabar({ order_name: (real ? "PRUEBAREAL" : "PRUEBA") + Date.now().toString().slice(-5), ...(real ? destReal : dest), email: "hola@singularwardrobe.com", bultos: 1, peso_kg: 1 }, { ...cfg, gls_modo: real ? "real" : "pruebas" });
      if (real) { await evento(null, "gls_prueba_real", { codbarras: g.codbarras, uid: g.uid }, usuario); return json({ ok: true, real: true, codbarras: g.codbarras, uid: g.uid, pdf_bytes: g.pdf ? decodeBase64(g.pdf).length : 0, pdf: g.pdf }); }
      let reimp = 0, reimpError: string | null = null;
      try { const r = await glsEtiquetaEnvio(g.codbarras, "pruebas"); reimp = r ? decodeBase64(r).length : 0; } catch (e) { reimpError = String((e as Error).message ?? e); }
      return json({ ok: true, url: GLS_URL, pais: dest.pais, codbarras: g.codbarras, uid: g.uid, pdf_bytes: g.pdf ? decodeBase64(g.pdf).length : 0, reimpresion_bytes: reimp, reimpError, reimpRaw: reimp ? undefined : glsUltimaReimpresion, raw: g.raw });
    }
    return json({ ok: false, error: `acción desconocida: ${accion}` }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message ?? e), raw: (e as any)?.raw ?? undefined }, 500);
  }
});
