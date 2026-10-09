// fab v4 — Gestión de producción Singular Wardrobe
// Estados por prenda: pendiente → sin_stock → cortar → estampar → empaquetar; el pedido (trigger en BD) toma el de su prenda más atrasada.
// Acciones: importar · lineas · producido · impresa · reimprimir · diag · prueba_gls
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

const Q_PEDIDOS = `query Pedidos($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) {
  pageInfo { hasNextPage endCursor }
  nodes { id name createdAt cancelledAt displayFulfillmentStatus tags note email phone
    shippingAddress { name address1 address2 city province zip countryCodeV2 phone company }
    shippingLine { title }
    lineItems(first: 50) { nodes { id title variantTitle sku currentQuantity customAttributes { key value } image { url } } } } } }`;

// ───────── IMPORTAR ─────────
async function importar(usuario: string) {
  const cfg = await config();
  const dias = Number(cfg.importar_dias_atras ?? "7");
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

  const ids = pedidos.map((o) => idNum(o.id));
  const { data: existentes } = await sb.from("fab_pedidos").select("order_id").in("order_id", ids.length ? ids : [0]);
  const ya = new Set((existentes ?? []).map((r) => Number(r.order_id)));

  let nuevos = 0;
  for (const o of pedidos) {
    const order_id = idNum(o.id);
    if (ya.has(order_id) || o.cancelledAt) continue;
    const a = o.shippingAddress ?? {};
    const { error } = await sb.from("fab_pedidos").insert({
      order_id, order_name: o.name, creado_shopify: o.createdAt,
      cliente_nombre: [a.name, a.company].filter(Boolean).join(" · ") || null,
      email: o.email, telefono: a.phone || o.phone || null,
      direccion1: a.address1, direccion2: a.address2, ciudad: a.city, provincia: a.province,
      cp: a.zip, pais: a.countryCodeV2, metodo_envio: o.shippingLine?.title ?? null,
      nota: o.note, tags: o.tags ?? [], peso_kg: Number(cfg.peso_defecto_kg ?? "1"),
    });
    if (error) { await evento(order_id, "error_importacion", { error: error.message }, usuario); continue; }
    const lineas = o.lineItems.nodes.filter((l: any) => l.currentQuantity > 0).map((l: any) => ({
      line_id: idNum(l.id), order_id, titulo: l.title, variante: l.variantTitle, sku: l.sku,
      cantidad: l.currentQuantity, personalizacion: (l.customAttributes ?? []).filter((x: any) => x.value && !x.key.startsWith("_")),
      imagen_url: l.image?.url ?? null,
    }));
    if (lineas.length) await sb.from("fab_lineas").insert(lineas);
    nuevos++;
  }

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

  const res = { revisados: pedidos.length, nuevos, cancelados, enviados_fuera: fuera };
  await evento(null, "importacion", res, usuario);
  return res;
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
      trackingInfo: { company: "GLS Spain, S.A.", number: p.gls_codbarras, url: `https://mygls.gls-spain.es/e/${p.gls_codbarras}/${(p.cp ?? "").replace(/\s/g, "")}` },
      notifyCustomer: true,
    },
  });
  const ue = m.fulfillmentCreate.userErrors;
  if (ue.length) throw new Error(ue.map((e: any) => e.message).join("; "));
  return m.fulfillmentCreate.fulfillment.id as string;
}

// ───────── PRODUCIDO ─────────
async function producido(order_id: number, usuario: string) {
  const cfg = await config();
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
      if (!data?.user) return json({ ok: false, error: "no autorizado" }, 401);
      usuario = data.user.email ?? data.user.id;
    }

    if (accion === "importar") {
      if (usuario === "cron" && url.searchParams.get("solo7") === "1" && horaMadrid() !== 7) return json({ ok: true, omitido: "no son las 7 en Madrid" });
      return json({ ok: true, ...(await importar(usuario)) });
    }

    const order_id = Number(body.order_id);
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
