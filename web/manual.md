# Manual de uso · Programa de fábrica Singular Wardrobe

Este programa organiza todos los pedidos de la tienda online desde que entran hasta que salen del taller. Se abre en el navegador en [tallersingular.netlify.app](https://tallersingular.netlify.app) y lo usamos todas a la vez, desde un ordenador compartido o una tablet.

## 1. Antes de empezar

Cada mañana a las 8:00 el programa trae los pedidos nuevos de la tienda y recoge los cambios de los que ya tenía (por ejemplo, una talla cambiada). No hace falta hacer nada para que aparezcan.

**Entrar**

1. Abre Chrome y entra en tallersingular.netlify.app.
2. Escribe el email y la contraseña de la fábrica y pulsa Entrar.
3. Si el ordenador se queda encendido, la sesión sigue abierta al día siguiente.

**¿No recuerdas la contraseña?** Pídele a Tito que te ponga una nueva desde 👥. También puedes escribir tu email en la pantalla de entrada y pulsar **¿Has olvidado la contraseña?**: te llega un correo con un enlace (mira también en correo no deseado) y, al abrirlo, el programa te pide la contraseña nueva dos veces. El enlace solo vale una vez y caduca al cabo de un rato.

**Dar de alta a una persona (solo el administrador)**

El botón **👥** de arriba solo le sale al administrador. Sirve para dar de alta a cada persona y ponerle contraseña, sin correos.

1. Pulsa **👥**. Sale la lista de usuarios con su último acceso.
2. En **Añadir persona** escribe su nombre y un email que hará de nombre de usuario. No hace falta que exista: por ejemplo dania@singularwardrobe.com.
3. Escribe una contraseña o pulsa **Generar** (sale una fácil de dictar, como «Coral-4821-mar»), elige su **puesto** y pulsa **Añadir**.
4. Dile a esa persona su email y su contraseña. Después puede cambiarla ella con 🔑.

Si alguien olvida la contraseña, en su fila pulsa **🔑 Poner contraseña**. Para cambiarle el puesto, márcalo en su fila: lo verá al recargar la página. Para que alguien deje de entrar, pulsa **Quitar acceso** dos veces.

**Tu pantalla según tu puesto**

| Puesto | Qué ve |
| --- | --- |
| Administración | El programa entero: Plan del día, Pedidos, Resumen producción, Histórico y Ayuda. |
| Producción | Dos pasos. **1 · Cortar vinilo**: la hoja de corte por color. **2 · Estampar**: los pedidos con su vinilo cortado, con los botones ✔ Estampado, ✖ Vinilo mal y Falta la prenda. |
| Expedición | **Empaquetar**: un botón por pedido según cómo sale (etiqueta GLS, Otros envíos o recogida). **Hechos hoy**: lo que ha salido, para reimprimir una etiqueta. **Recogidas en tienda**: ✔ Entregado al cliente. |

En Producción y Expedición todo lo que haces queda a tu nombre sin preguntar. El buscador de arriba encuentra un pedido: escanea el código de la hoja o escribe su número. Si un pedido lo está haciendo otra compañera, sale en gris y al final de la lista.

**Botones de la parte de arriba**

| Botón | Para qué sirve |
| --- | --- |
| Plan del día | Lo primero de cada mañana: el cuadro del día, el orden de trabajo, las hojas de pedido y la lista de recogida de prendas. |
| Pedidos | La pantalla de trabajo: todos los pedidos ordenados por pestañas. |
| Resumen producción | La hoja de corte de vinilo por color y lo que hay que estampar, agrupado por modelo y talla. |
| Histórico | Los pedidos ya estampados o enviados, con quién lo hizo. |
| Ayuda | Este manual, con buscador por palabras y botón para imprimirlo en PDF. |
| ↻ Importar | Trae ahora los pedidos nuevos de la tienda y los cambios de los que ya están, sin esperar a mañana. |
| 👥 | Solo le sale al administrador: dar de alta a las personas, ponerles contraseña o quitarles el acceso (ver arriba). |
| 🔑 | Cambia la contraseña con la que se entra: escribe la nueva dos veces (mínimo 8 caracteres) y pulsa Guardar. Si ese usuario lo usáis varias, avisa a las demás. |
| Salir | Cierra la sesión. Úsalo solo si el ordenador lo usa otra gente. |

**Avisos de colores en la franja superior**

- **Franja roja «ERROR: no actualizado hoy»**: la actualización de las 8:00 ha fallado. Pulsa ↻ Importar. Si vuelve a salir, avisa a Tito.
- **Franja amarilla «MODO PRUEBAS»**: las etiquetas de GLS todavía son de prueba y no sirven para enviar. Desaparecerá cuando el programa funcione de verdad.

Todas las pantallas, los listados impresos, los PDF y los Excel llevan el logo de Singular Wardrobe.

La pantalla se actualiza sola: lo que hace una compañera aparece en tu pantalla en unos segundos. Si dudas, recarga la página con Cmd + Shift + R en Mac o Ctrl + F5 en Windows.

## 2. El recorrido de un pedido

![Plan, corte, estampado y empaquetado; sale por una de tres vías](ayuda-recorrido.svg)

Por la mañana se imprimen las hojas de pedido y se recogen las prendas. El vinilo se corta por color y espera en el almacén de vinilos; cuando un pedido tiene el suyo, pasa a Estampar, y después lo empaqueta otra persona. El programa decide por qué vía sale según el destino. Las prendas «sin vinilo» van directas a Empaquetar. Si falta la prenda, el pedido espera en Sin stock (y su vinilo, en el almacén) hasta que llega.

## 3. El arranque del día: plan, hojas y recogida

La pantalla **Plan del día** es lo primero que se mira cada mañana. Dice cuánto trabajo hay, en qué orden se hace y prepara el papel y las prendas.

**El cuadro del día**

- La franja de arriba dice si hoy se puede sacar todo: **verde**, hoy se puede; **amarilla**, día justo; **roja**, hay trabajo para más de un día y hace falta reforzar o priorizar. Compara la cola con lo que se saca en un día normal (de 70 a 90 pedidos).
- Los recuadros: pedidos en cola (y cuántos vienen de días anteriores), entrados hoy, salidos hoy, retrasados, urgentes, en Sin stock y modificados. Debajo, cuántos hay de cada tipo de trabajo y en cada etapa.

**Tipo de trabajo (carril).** El programa clasifica cada pedido; ya no hay que separarlos a mano.

| Tipo | Qué lleva |
| --- | --- |
| Solo empaquetar | Prendas «sin vinilo»: se cogen de la estantería y se empaquetan. |
| Estándar | Vinilo igual para todas las clientas: se corta en tanda, por color. |
| Personal | Vinilo hecho para esa clienta (nombre, iniciales…). |
| Mixto | Prendas de más de un tipo. |

**El plan.** La tabla de abajo es el orden de trabajo: urgentes primero y después del más antiguo al más nuevo. Lo que no salió ayer va siempre delante de lo de hoy. La columna **Sale** es una previsión: con la capacidad de un día normal, qué día debería salir cada pedido. La raya negra marca hasta dónde llega un día normal. Pulsa un número de pedido para ver su tarjeta.

**Primero: imprimir las hojas de pedido (8:15)**

1. Pulsa **🖨 Imprimir hojas nuevas (N)**. Salen solo los pedidos que aún no tienen hoja; los de días anteriores ya la tienen en su bolsa.
2. Se imprimen 4 hojas por folio A4, ya ordenadas: urgentes primero, después por tipo de trabajo y por modelo y talla.
3. Cada hoja lleva el número de pedido en grande, su **código de barras**, el **hueco** de la estantería, por dónde sale, las prendas con una casilla, la personalización en grande y la nota de la clienta. Los urgentes llevan una franja negra «URGENTE».
4. Cada hoja va en una bolsa. Si el pedido no se acaba hoy, la bolsa espera en su hueco.

Si un pedido cambia después de imprimir su hoja (por ejemplo, la clienta cambia la talla), vuelve a salir en «Imprimir hojas nuevas» y la hoja nueva lleva la marca **MODIFICADA**: tira la vieja. Si una hoja se pierde, en la tarjeta del pedido pulsa **🖨 Reimprimir hoja**: sale marcada **COPIA**.

**Después: recoger las prendas (8:15 a 8:45)**

1. Pulsa **📋 Lista de recogida**. Salen las prendas de los pedidos del plan de hoy, agrupadas por modelo y talla, con sus pedidos y su hueco.
2. Saca cada prenda de la estantería, métela en la bolsa de su pedido y pulsa **✔ Hay**.
3. Si solo hay algunas, escribe cuántas hay y pulsa ✔ Hay: los urgentes y más antiguos se quedan las que hay y el resto pasa a Sin stock.
4. Si no hay ninguna, pulsa **✖ No hay**: el pedido pasa a Sin stock aunque Shopify diga que hay stock. Manda lo que se ve en la estantería.
5. Arriba de la lista salen las prendas en **Sin stock**: si ya han llegado, pulsa **✔ Ha llegado** y el pedido vuelve al trabajo.
6. **Todos los pedidos** enseña la lista completa, no solo la de hoy. **🖨 Imprimir** la saca en papel.

**Los huecos de la estantería.** Cada pedido recibe un número de hueco al imprimir su hoja. Sale en la hoja, en la tarjeta (recuadro negro «Hueco N») y en el plan. Cuando el pedido sale, su hueco queda libre para otro.

## 4. Las pestañas de Pedidos

Cada pestaña muestra un grupo de pedidos y, al lado, cuántos hay. La etiqueta roja «N urg» indica cuántos son urgentes. Dentro de cada pestaña, los urgentes salen primero y después los más antiguos.

| Pestaña | Qué hay |
| --- | --- |
| ⚠ Retrasados | Pedidos que no han salido después de más de 7 días (urgentes: más de 3 días). Son la prioridad. |
| ✏️ Modificados | Pedidos que la clienta ha cambiado en Shopify después de entrar (talla, prendas, dirección…) o con el texto de personalización corregido. Solo aparece si hay alguno. |
| Pendientes | Solo aparece si alguien ha apartado un pedido a mano. |
| Sin stock | Pedidos con alguna prenda que no está. Cuando llegue, pulsa ✔ Ha llegado. |
| Cortar vinilo | Pedidos que esperan su vinilo. El estándar se corta en el Resumen; el personal, prenda a prenda. |
| Estampar | Pedidos con el vinilo ya cortado: hay que estamparlos. |
| Empaquetar | Pedidos con todas las prendas hechas, listos para empaquetar y dar salida. |
| Producidos hoy | Lo que ha salido hoy. |
| Otros envíos | Pedidos que salieron sin etiqueta GLS (Canarias, fuera de la UE…), con la anotación de cómo salieron. |
| Recogida en tienda | Todos los pedidos que el cliente viene a buscar al taller. |
| Listos para recoger | Recogidas terminadas que el cliente aún no ha venido a buscar. |
| Recogidos | Recogidas ya entregadas al cliente, las últimas primero. |
| Sin etiqueta | Pedidos que han salido pero cuya etiqueta GLS no se llegó a imprimir. Hay que revisarlos. |
| Todos | Todos los pedidos del programa. |

El buscador de la derecha encuentra un pedido por su número (por ejemplo 40250) o por el nombre del cliente.

## 5. Cómo leer una tarjeta de pedido

Cada pedido es una tarjeta con todo lo necesario para hacerlo sin abrir Shopify.

**Arriba de la tarjeta**

- **Número de pedido** (por ejemplo #40250), fecha en que se hizo y, si tiene 2 días o más, «hace N días».
- **Tarjeta roja y etiqueta URGENTE**: el cliente pagó envío Exprés o el pedido lleva la etiqueta «urgente». Se hace antes que los demás.
- **RETRASADO · N días**: lleva demasiado tiempo en el taller. Prioridad máxima.
- **✏️ MODIFICADO**: el pedido ha cambiado después de entrar. Debajo sale un recuadro morado con los cambios (apartado 12).
- **Etapa** en la que está (Cortar vinilo, Estampar, Empaquetar…).
- **Tipo de trabajo**: Solo empaquetar, Estándar, Personal o Mixto (apartado 3).
- **Hueco N**, en negro: el hueco de la estantería donde espera su bolsa.
- **Otras marcas**: Recogida taller, el país si no es España, 📦 Canarias / Reino Unido / Fuera de la UE si va por Otros envíos, o el nombre de quien lo tiene cogido.

**Debajo, el cliente**: nombre, ciudad y código postal. En los urgentes también el tipo de envío.

**Las prendas**, una por línea:

- Foto y nombre del modelo. Si hay más de una unidad, delante pone «2×».
- **Talla** dentro de un recuadro. Si pone «Sin talla», revisa el pedido antes de hacerlo.
- **Personalización** en negro (iniciales, nombre, número…): es exactamente lo que hay que cortar. Comprueba letra por letra. Al lado, el botón **✏️ Corregir texto** sirve para arreglarla si la clienta se ha equivocado (apartado 12).
- **Sin vinilo · stock N**: prenda que no se corta (ver apartado 9).

**📝 Nota del cliente**, en amarillo: lo que el cliente escribió al comprar (por ejemplo «envolver para regalo»). Léela siempre. Los clientes no pueden cambiarla después.

**Abajo, los botones** de la etapa en la que está el pedido. Se explican en los apartados 6 a 10. Debajo de todo, **🖨 Imprimir hoja** (o Reimprimir) saca su hoja de pedido y **🔄 Actualizar desde Shopify** trae al momento los cambios que se hayan hecho en ese pedido en Shopify.

## 6. Repartirse el trabajo

Antes de ponerte con un pedido, cógelo: así tu nombre sale en la tarjeta y nadie más lo hace a la vez.

Encima de la lista de pedidos hay una barra con: **Todos · Libres · Dania · Irene · Andrea · Mica · Cristina · Carlota**. Cada persona tiene su color y al lado el número de pedidos que tiene cogidos.

| Quiero… | Qué hago |
| --- | --- |
| Ver solo mis pedidos | Toco mi nombre en la barra. Desde ese momento, todo lo que coja se me asigna a mí sin preguntar. |
| Ver los que nadie ha cogido | Toco Libres. |
| Coger un pedido | En la tarjeta pulso ✋ Coger. Si no tengo mi nombre marcado en la barra, sale «¿Quién coge…?» y toco mi nombre. |
| Coger varios de golpe | Pulso ✋ Coger 5 siguientes. Me asigna los 5 primeros libres, urgentes primero. |
| Pasar un pedido a otra compañera | En la tarjeta pulso Cambiar y toco su nombre. |
| Devolver un pedido que no voy a hacer | En la tarjeta pulso Soltar. Vuelve a Libres. |

**Al terminar cada parte, el pedido vuelve a quedar libre.** Quien estampa lo coge en Estampar; al pulsar «Estampado» llega libre a Empaquetar, y allí lo coge quien empaqueta. Al darle salida, también queda libre.

**Si compartís un ordenador**, cuando llegues al PC toca tu nombre en la barra, y al irte toca Todos. En una tablet personal puedes dejar tu nombre marcado: la tablet lo recuerda.

El nombre del pedido cogido sale en grande en la tarjeta. Si ves uno con el nombre de otra persona, no lo toques sin hablar con ella.

## 7. Paso 1 · Cortar vinilo

Todos los pedidos nuevos con vinilo entran en **Cortar vinilo**. Aquí solo se corta; el estampado es el paso siguiente.

**Vinilo estándar (igual para todas): en el Resumen**

1. Ve a **Resumen producción → Cortar vinilo**. Es la **hoja de corte**: agrupa los modelos por **color de vinilo** para cortar cada color de una vez.
2. Corta lo que pone «por cortar» en cada modelo y talla. Incluye lo de pedidos **sin prenda**: se corta igual y se guarda.
3. Apunta las cortadas (**✔ Cortadas** o **Todos**). El vinilo entra en el **almacén de vinilos** y el programa lo reparte solo: cuando un pedido tiene todo su vinilo y ninguna prenda en Sin stock, pasa solo a **Estampar**. Primero los urgentes y los más antiguos.
4. El vinilo que no se reparte se queda en el almacén hasta que llega su prenda.

**Vinilo personal (para una clienta)**

1. En el Resumen, en Cortar vinilo, cada prenda personalizada sale en su línea con el texto en grande. Compruébalo letra por letra.
2. Córtalo y pulsa **✔ Cortada**: esa prenda pasa a Estampar.
3. También se puede desde la tarjeta del pedido: **Vinilo cortado · a estampar →**.

**Color de cada modelo.** Si un modelo sale en «Sin color de vinilo asignado», pulsa **🎨 ¿Color?** junto a su nombre y escribe el color, o elige uno de los que ya hay. Se apunta una vez y se queda.

**Si falta la prenda**, pulsa **Sin stock** en la tarjeta. El pedido espera en la pestaña Sin stock; su vinilo, si ya estaba cortado, espera en el almacén.

## 8. Paso 2 · Estampar

En la pestaña **Estampar** están los pedidos que ya tienen su vinilo cortado.

1. Coge el pedido (apartado 6).
2. Estampa cada prenda tal como pone la tarjeta: modelo, talla y personalización.
3. Pulsa **Estampado · a empaquetar →**.
4. Si el pedido estaba cogido por ti, se guarda solo que lo has estampado tú. Si no, sale «¿Quién lo ha estampado?»: toca tu nombre.
5. El pedido desaparece de Estampar y aparece **libre** en Empaquetar.

**Si el vinilo sale mal** (se rompe, queda torcido…), pulsa **✖ Vinilo mal**: ese vinilo se descarta y la prenda vuelve a Cortar vinilo. Si hay otro igual en el almacén, el programa se lo da enseguida y vuelve a Estampar.

**Si falta la prenda**, pulsa **Sin stock**: el pedido espera en Sin stock y su vinilo vuelve al almacén.

En el Resumen, pestaña **Estampar**, se ven todas las prendas por estampar agrupadas por modelo y talla; **✔ Estampadas** pasa las de esa línea a Empaquetar.

**Pedidos que se mueven solos.** No te asustes si un pedido cambia de pestaña sin que nadie lo toque:

- Pasa a **Estampar** cuando el almacén tiene su vinilo (apartado 9).
- Pasa a **Empaquetar** si sus prendas son «sin vinilo» y hay stock (apartado 11).

En el Histórico esos pedidos aparecen con «Estampado por: Sin indicar» si nadie lo indicó.

## 9. Resumen de producción

El Resumen dice cuántos vinilos hay que cortar de cada modelo y talla, sumando todos los pedidos, y qué falta por estampar. Es la hoja de trabajo de la mesa de corte y de la plancha.

**Cómo está ordenado**

- Pestañas arriba: **Sin stock**, **Cortar vinilo** (la hoja de corte), **Estampar** y **Todos** (todo lo que falta por hacer, con la etapa de cada prenda).
- En Cortar vinilo los modelos van agrupados por **color de vinilo**, con lo que falta por cortar de cada color. Las prendas estándar de pedidos sin prenda también cuentan: se cortan y se guardan.
- Cada bloque es un modelo; dentro, una línea por talla y color, con el número que falta y los pedidos que lo llevan (⚡ = urgente).
- Las prendas **personalizadas** salen una por línea, con la personalización en grande y la nota del cliente si la hay.
- El desplegable de fechas permite ver todos los días, solo lo entrado hasta ayer o solo lo de hoy.

**Apuntar vinilos cortados (prendas sin personalización)**

1. Escribe en la casilla de esa línea cuántos vinilos has cortado y pulsa **✔ Cortadas**. Si los has cortado todos, pulsa **Todos**.
2. El número «por cortar» baja y debajo pone cuántos llevas cortados.
3. Los vinilos entran en el **almacén** y el programa los reparte solos entre los pedidos, urgentes y más antiguos primero. Un pedido pasa a **Estampar** cuando tiene todo su vinilo estándar y ninguna prenda en Sin stock. Si no, se salta y el vinilo queda para el siguiente.
4. ¿Te has equivocado al apuntar? Pulsa **−1** para restar una.

**Prendas personalizadas**

En Cortar vinilo, **✔ Cortada** pasa esa prenda a Estampar. En Estampar, **✔ Estampada** la pasa a Empaquetar. El pedido pasa entero cuando todas sus prendas están hechas.

**Mover varias a la vez**

Marca las casillas de la izquierda (de una línea o de un modelo entero). Abajo sale una barra para pasarlas todas juntas a la etapa siguiente o a Sin stock.

**Imprimir y Excel**

- **🖨 Imprimir listado**: saca el Resumen en papel para la mesa de corte.
- **⬇ Excel**: descarga un Excel con dos hojas, el resumen por modelo y el detalle prenda a prenda.

## 10. Paso 3 · Empaquetar y dar salida

En Empaquetar cada tarjeta muestra un solo botón de salida. El programa ya ha decidido cómo sale el pedido según el destino; tú solo empaquetas y pulsas.

| Destino del pedido | Botón que aparece |
| --- | --- |
| Península, Baleares y países de la UE | ✔ Etiqueta GLS |
| Canarias, Ceuta, Melilla, Reino Unido, Suiza, Noruega, Andorra y resto del mundo | 📦 Otros envíos · (zona) |
| Sin dirección: el cliente lo recoge en el taller | ✔ Listo para recoger |

En los tres casos, al pulsar sale **«¿Quién lo ha empaquetado?»**: toca tu nombre. Si arriba tienes tu nombre marcado, no pregunta.

**Con etiqueta GLS**

1. Coge el pedido, revisa las prendas contra la tarjeta y empaquétalo.
2. Pulsa **✔ Etiqueta GLS** y toca tu nombre.
3. Espera unos segundos: la etiqueta se pide a GLS y se imprime sola. Pégala en el paquete.
4. La tarjeta pasa a Producidos hoy con «✔ Etiqueta impresa» y el número de envío de GLS.
5. Si la etiqueta sale mal o se pierde, en esa tarjeta pulsa **Reimprimir**.

Si aparece un error de GLS, el pedido queda en la pestaña Sin etiqueta. No lo envíes sin etiqueta: avisa a Tito.

**Si te has equivocado** y un pedido ha llegado a Empaquetar sin estar terminado, pulsa **↶** en su tarjeta: las prendas con vinilo vuelven a Estampar.

**Otros envíos (sin GLS)**

1. Empaqueta el pedido y pulsa **📦 Otros envíos · …**.
2. Se abre una casilla: escribe cómo sale (transportista, número de seguimiento, entregado en mano…).
3. Pulsa **✔ Confirmar otros envíos** y toca tu nombre.
4. Queda en la pestaña Otros envíos. Si luego tienes el número de seguimiento, escríbelo allí y pulsa **Guardar**.
5. De momento estos pedidos hay que marcarlos también a mano como enviados en Shopify.

**Recogida en tienda**

1. Prepara el paquete y pulsa **✔ Listo para recoger**. Toca tu nombre.
2. El pedido pasa a la pestaña Listos para recoger.
3. Cuando el cliente venga, busca el pedido y pulsa **✔ Entregado al cliente**. Pasa a Recogidos.
4. ¿Lo has marcado por error? En Recogidos pulsa **Deshacer**.

## 11. Productos sin vinilo y stock

Algunos productos no se cortan ni se estampan: se venden tal cual, como los pantalones «cupido». En Shopify llevan la etiqueta **sin vinilo**.

- Cada mañana (o al pulsar ↻ Importar) el programa mira el stock de esos productos.
- **Si hay stock**, la prenda pasa sola a Empaquetar. No hay que cortar ni estampar nada.
- **Si no hay stock**, la prenda va a Sin stock. Cuando entre stock en Shopify, la siguiente importación la pasa sola a Empaquetar.
- Si no llega para todos, se sirven primero los urgentes y los más antiguos.
- En la tarjeta, estas prendas llevan la marca **Sin vinilo · stock N**.
- Si al recogerla no está, pulsa **✖ No hay** en la lista de recogida: se queda en Sin stock aunque Shopify diga que hay, hasta que pulses **✔ Ha llegado**.

Estos productos no salen en la hoja de corte ni usan el almacén de vinilos.

**Producto nuevo que no se corta**: hay que ponerle la etiqueta «sin vinilo» en Shopify. Lo hace quien da de alta los productos; si ves uno que falta, avísale.

## 12. Cambios de la clienta (talla, dirección o texto)

Si una clienta se equivoca y pide un cambio, **la talla, las prendas y la dirección se cambian en Shopify**. El texto de personalización se corrige aquí, porque Shopify no deja cambiarlo en un pedido ya hecho.

| Qué cambia | Dónde se cambia | Cómo |
| --- | --- | --- |
| Talla o prenda | Shopify | En el pedido, «Editar»: quita la prenda equivocada y añade la buena. |
| Cantidad | Shopify | En el pedido, «Editar». |
| Dirección o teléfono | Shopify | En el pedido, edita la dirección de envío. |
| Texto de personalización | Este programa | En la tarjeta, botón ✏️ Corregir texto. |

**Cuándo lo ve el taller**

- Cada mañana a las 8:00 el programa revisa los pedidos abiertos y recoge los cambios. También al pulsar ↻ Importar.
- Para verlo al momento, en la tarjeta del pedido pulsa **🔄 Actualizar desde Shopify**.

**Qué hace el programa con un cambio**

- La tarjeta lleva la marca **✏️ Modificado** y un recuadro morado con la lista de cambios. El pedido sale también en la pestaña ✏️ Modificados.
- **Talla cambiada**: la prenda nueva entra en Cortar vinilo. Si la antigua ya estaba hecha, el aviso dice «apártala»; si solo tenía el vinilo cortado, el vinilo vuelve al almacén.
- **Prenda añadida**: entra en Cortar vinilo.
- **Prenda quitada**: desaparece del pedido. Si ya estaba hecha o preparada, el aviso lo dice: apártala.
- **Más unidades de una prenda ya hecha**: la prenda vuelve a Cortar vinilo. Si hay menos unidades, el aviso dice cuántas sobran.
- **Dirección nueva**: se actualiza, y con ella el tipo de salida (GLS u Otros envíos).
- Si su hoja ya estaba impresa, vuelve a salir en «Imprimir hojas nuevas» marcada MODIFICADA.
- Cuando lo hayas leído y hecho lo necesario, pulsa **✔ Visto**. El recuadro desaparece; el cambio queda guardado en el registro.

**Corregir el texto de personalización**

1. En la tarjeta, pulsa **✏️ Corregir texto** junto al texto.
2. Escribe el texto bueno y pulsa **Guardar**. Si arriba no tienes tu nombre marcado, toca tu nombre.
3. El texto nuevo sustituye al antiguo en la tarjeta, en el Resumen y en el Histórico. Debajo queda «Texto corregido por… · antes: …» para comprobarlo.
4. El cambio solo está en este programa: en Shopify sigue el texto que puso la clienta.

**Pedidos que ya han salido** no se tocan: si la clienta cambia algo después de enviarlo, ya no hay nada que hacer en el taller.

## 13. Histórico

El Histórico muestra los pedidos que han salido (o que se han estampado) en un día o un periodo, con quién hizo cada parte. Sirve para buscar un pedido antiguo y para saber cuánto ha hecho cada una.

**Buscar**

1. Pulsa **Histórico** arriba. Siempre se abre con los datos al día y con los pedidos de hoy.
2. Elige las fechas en **Desde** y **Hasta**, o pulsa un atajo: Hoy, Ayer, 7 días, Este mes, Mes anterior.
3. En **Fecha de** elige si buscas por fecha de **salida** (empaquetado o enviado) o de **estampado**.
4. En **Persona** elige a alguien. En **Como** indica si la buscas como estampadora, empaquetadora o cualquiera de las dos.
5. En **Pedido o cliente** escribe un número o un nombre.
6. Si estás mirando y siguen saliendo pedidos, pulsa **↻ Refrescar**. Junto al título pone a qué hora se actualizó.

**Qué se ve**

- Arriba, un resumen por persona, por ejemplo «Dania · 3 estampados · 0 empaquetados».
- Debajo, una tabla con cada pedido: número y fecha, cliente y destino, prendas con talla y personalización, quién lo estampó y cuándo, quién lo empaquetó y cuándo, cómo salió (número GLS, Otros envíos o recogida) y la nota del cliente.

**Guardar o compartir**

- **🖨 PDF**: imprime solo la tabla. En la ventana de impresión elige «Guardar como PDF» si lo quieres en archivo.
- **⬇ Excel**: descarga un Excel con el listado completo y una segunda hoja con el total por persona.

Los pedidos que salieron hace más de 30 días ya no aparecen en la pantalla de Pedidos: están en el Histórico.

## 14. Ayuda

Este manual está siempre en el programa, en el botón **Ayuda** de arriba.

- **Buscar**: escribe una o varias palabras (por ejemplo «etiqueta», «sin stock» o «recogida»). Solo quedan los apartados que las contienen, con las palabras marcadas en amarillo. No importa si escribes con o sin acentos.
- **Índice**: sin buscar nada, arriba aparece el índice; pulsa un apartado para ir a él.
- **🖨 PDF**: imprime el manual (o solo los apartados encontrados). En la ventana de impresión elige «Guardar como PDF» para tenerlo en archivo.

Cada vez que el programa cambia, este manual se actualiza con el cambio.

## 15. Problemas frecuentes

| Qué pasa | Qué hacer |
| --- | --- |
| Franja roja «ERROR: no actualizado hoy» | Pulsa ↻ Importar. Si sigue saliendo, avisa a Tito. |
| No recuerdo la contraseña | Pídele a Tito que te ponga una nueva desde 👥 (apartado 1). También puedes pulsar «¿Has olvidado la contraseña?» en la pantalla de entrada. |
| Falta un pedido que sí está en Shopify | Pulsa ↻ Importar y búscalo por número en el buscador. |
| No veo lo que ha hecho una compañera | Recarga la página con Cmd + Shift + R (Mac) o Ctrl + F5 (Windows). |
| Un pedido ha pasado solo a Estampar o a Empaquetar | Es normal: el almacén tenía su vinilo (pasa a Estampar) o sus prendas son sin vinilo y hay stock (pasa a Empaquetar). Apartados 9 y 11. |
| He pulsado «Estampado» por error | En Empaquetar pulsa ↶ y el pedido vuelve a Estampar. |
| El vinilo ha salido mal | En la tarjeta, en Estampar, pulsa ✖ Vinilo mal (apartado 8). |
| Se ha perdido la hoja de un pedido | En su tarjeta pulsa 🖨 Reimprimir hoja: sale marcada COPIA. |
| Shopify dice que hay stock pero no está | En la lista de recogida pulsa ✖ No hay (apartado 3). |
| Un modelo sale «Sin color de vinilo asignado» | En la hoja de corte pulsa 🎨 ¿Color? y escribe su color (apartado 7). |
| He apuntado vinilos cortados de más | En el Resumen pulsa −1 tantas veces como haga falta. |
| No sale el botón de Etiqueta GLS | El destino va por Otros envíos (Canarias, Reino Unido, fuera de la UE…). Es correcto. |
| La etiqueta no se ha impreso | En la tarjeta pulsa Reimprimir. Si no aparece, mira la pestaña Sin etiqueta y avisa a Tito. |
| Error de GLS al pedir la etiqueta | No envíes el paquete. Avisa a Tito con el número de pedido. |
| He elegido mal quién lo ha hecho | Avisa a Tito para corregirlo en el Histórico. |
| La talla pone «Sin talla» | Revisa el pedido en Shopify antes de cortar. |
| La clienta ha cambiado la talla y aquí sigue la antigua | Cámbiala en Shopify y en la tarjeta pulsa 🔄 Actualizar desde Shopify (apartado 12). |
| La personalización está mal escrita | En la tarjeta pulsa ✏️ Corregir texto (apartado 12). |
| Un pedido sale con ✏️ Modificado | Lee el recuadro morado, haz lo que diga y pulsa ✔ Visto. |

## 16. Reglas de oro

1. **Empieza el día por el Plan del día:** hojas nuevas, recogida de prendas y retrasados.
2. **Coge antes de trabajar.** Un pedido con tu nombre es tuyo; uno con el nombre de otra, no se toca sin hablar.
3. **Comprueba la personalización letra por letra** antes de cortar.
4. **Lee siempre la nota del cliente y los cambios marcados con ✏️.**
5. **Toca tu nombre cuando el programa pregunte quién lo ha hecho.** Así el Histórico es fiable.
6. **Pulsa «Estampado» solo cuando todas las prendas del pedido estén estampadas.**
7. **Ningún paquete sale sin etiqueta impresa** o sin anotar cómo sale en Otros envíos.
8. **Si algo no cuadra, para y avisa** antes de enviar.
9. **Cada pedido, en su bolsa con su hoja y en su hueco.**
