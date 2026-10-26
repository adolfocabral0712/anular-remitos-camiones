const VIDA_SOLICITUD_MS = 24 * 60 * 60 * 1000;

function respuestaJSON(datos, estado = 200) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function normalizarMatricula(valor) {
  return String(valor || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizarCI(valor) {
  return String(valor || "").replace(/\D/g, "");
}

function leerCandidatos(fila) {
  try {
    return JSON.parse(fila.candidates_json || "[]");
  } catch {
    return [];
  }
}

function vistaPublica(fila) {
  if (!fila) {
    return { ok: false, status: "no_encontrada" };
  }

  if (Date.now() - fila.created_at > VIDA_SOLICITUD_MS) {
    return {
      ok: true,
      status: "vencida",
      message: "La solicitud venció. Ingresá los datos nuevamente."
    };
  }

  return {
    ok: true,
    id: fila.id,
    status: fila.status,
    message: fila.message || "",
    candidates: leerCandidatos(fila)
  };
}

function autorizadoAgente(request, env) {
  const header = request.headers.get("Authorization") || "";
  return Boolean(env.AGENT_TOKEN) &&
    header === `Bearer ${env.AGENT_TOKEN}`;
}

async function crearSolicitud(request, env) {
  const body = await request.json().catch(() => null);

  if (!body || body.website) {
    return respuestaJSON(
      { ok: false, error: "Solicitud no válida." },
      400
    );
  }

  const matricula = normalizarMatricula(body.matricula);
  const ci = normalizarCI(body.ci);

  if (matricula.length < 5 || matricula.length > 10) {
    return respuestaJSON(
      { ok: false, error: "Revisá la matrícula ingresada." },
      400
    );
  }

  if (ci.length < 6 || ci.length > 9) {
    return respuestaJSON(
      { ok: false, error: "Revisá la cédula ingresada." },
      400
    );
  }

  const ahora = Date.now();
  const id = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO solicitudes
      (id, status, matricula, ci, created_at, updated_at)
    VALUES (?, 'pendiente_busqueda', ?, ?, ?, ?)
  `)
    .bind(id, matricula, ci, ahora, ahora)
    .run();

  return respuestaJSON({ ok: true, id });
}

async function estadoSolicitud(url, env) {
  const id = url.searchParams.get("id") || "";

  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return respuestaJSON(
      { ok: false, error: "Identificador no válido." },
      400
    );
  }

  const fila = await env.DB.prepare(
    "SELECT * FROM solicitudes WHERE id = ?"
  ).bind(id).first();

  return respuestaJSON(vistaPublica(fila));
}

async function confirmarAnulacion(request, env) {
  const body = await request.json().catch(() => null);

  if (!body || !body.id || !body.selected_id) {
    return respuestaJSON(
      { ok: false, error: "Faltan datos para confirmar." },
      400
    );
  }

  const fila = await env.DB.prepare(
    "SELECT * FROM solicitudes WHERE id = ?"
  ).bind(String(body.id)).first();

  if (!fila) {
    return respuestaJSON(
      { ok: false, error: "No se encontró la solicitud." },
      404
    );
  }

  if (fila.status !== "encontrado" && fila.status !== "varios") {
    return respuestaJSON(
      { ok: false, error: "La solicitud no está lista para confirmar." },
      409
    );
  }

  const candidatos = leerCandidatos(fila);
  const elegido = candidatos.find(
    registro => String(registro.id) === String(body.selected_id)
  );

  if (!elegido) {
    return respuestaJSON(
      { ok: false, error: "El registro elegido no coincide." },
      400
    );
  }

  const ahora = Date.now();

  const actualizacion = await env.DB.prepare(`
    UPDATE solicitudes
    SET status = 'pendiente_anulacion',
        selected_id = ?,
        updated_at = ?,
        claimed_at = NULL,
        message = 'Solicitud confirmada; esperando al agente.'
    WHERE id = ?
      AND status IN ('encontrado', 'varios')
  `)
    .bind(String(body.selected_id), ahora, String(body.id))
    .run();

  if (!actualizacion.meta || actualizacion.meta.changes !== 1) {
    return respuestaJSON(
      { ok: false, error: "La solicitud ya fue procesada." },
      409
    );
  }

  return respuestaJSON({
    ok: true,
    status: "pendiente_anulacion"
  });
}

async function siguienteTrabajo(request, env) {
  if (!autorizadoAgente(request, env)) {
    return respuestaJSON({ ok: false, error: "No autorizado." }, 401);
  }

  const ahora = Date.now();
  const vencido = ahora - 120000;

  // Solicitudes con más de 24 horas se eliminan, incluida la cédula.
  await env.DB.prepare(
    "DELETE FROM solicitudes WHERE created_at < ?"
  ).bind(ahora - VIDA_SOLICITUD_MS).run();

  const fila = await env.DB.prepare(`
    SELECT *
    FROM solicitudes
    WHERE status IN ('pendiente_busqueda', 'pendiente_anulacion')
       OR (
         status IN ('procesando_busqueda', 'procesando_anulacion')
         AND claimed_at < ?
       )
    ORDER BY created_at ASC
    LIMIT 1
  `).bind(vencido).first();

  if (!fila) {
    return respuestaJSON({ ok: true, job: null });
  }

  const esAnulacion =
    fila.status === "pendiente_anulacion" ||
    fila.status === "procesando_anulacion";

  const accion = esAnulacion ? "anular" : "buscar";
  const estadoProcesando = esAnulacion
    ? "procesando_anulacion"
    : "procesando_busqueda";

  await env.DB.prepare(`
    UPDATE solicitudes
    SET status = ?, claimed_at = ?, updated_at = ?
    WHERE id = ?
  `)
    .bind(estadoProcesando, ahora, ahora, fila.id)
    .run();

  return respuestaJSON({
    ok: true,
    job: {
      id: fila.id,
      accion,
      matricula: fila.matricula,
      ci: fila.ci,
      selected_id: fila.selected_id
    }
  });
}

async function recibirResultado(request, env) {
  if (!autorizadoAgente(request, env)) {
    return respuestaJSON({ ok: false, error: "No autorizado." }, 401);
  }

  const body = await request.json().catch(() => null);

  if (!body || !body.id || !body.accion || !body.status) {
    return respuestaJSON(
      { ok: false, error: "Resultado incompleto." },
      400
    );
  }

  const fila = await env.DB.prepare(
    "SELECT * FROM solicitudes WHERE id = ?"
  ).bind(String(body.id)).first();

  if (!fila) {
    return respuestaJSON(
      { ok: false, error: "No se encontró la solicitud." },
      404
    );
  }

  const ahora = Date.now();
  const mensaje = String(body.message || "").slice(0, 400);

  if (body.accion === "buscar") {
    const candidatos = Array.isArray(body.candidates)
      ? body.candidates.slice(0, 20).map(item => ({
          id: String(item.id || ""),
          remito: String(item.remito || ""),
          camion: String(item.camion || ""),
          acoplado: String(item.acoplado || ""),
          horario: String(item.horario || ""),
          origen: String(item.origen || ""),
          producto: String(item.producto || "")
        })).filter(item => item.id)
      : [];

    let status;
    if (candidatos.length === 0) {
      status = "sin_coincidencia";
    } else if (candidatos.length === 1) {
      status = "encontrado";
    } else {
      status = "varios";
    }

    const conservarDatos =
      status === "encontrado" || status === "varios";

    await env.DB.prepare(`
      UPDATE solicitudes
      SET status = ?,
          candidates_json = ?,
          message = ?,
          matricula = ?,
          ci = ?,
          claimed_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'procesando_busqueda'
    `)
      .bind(
        status,
        JSON.stringify(candidatos),
        mensaje,
        conservarDatos ? fila.matricula : null,
        conservarDatos ? fila.ci : null,
        ahora,
        String(body.id)
      )
      .run();

    return respuestaJSON({ ok: true, status });
  }

  if (body.accion === "anular") {
    const estadosPermitidos = new Set([
      "anulado",
      "registro_ya_cambio",
      "error_anulacion"
    ]);

    if (!estadosPermitidos.has(body.status)) {
      return respuestaJSON(
        { ok: false, error: "Estado de anulación no válido." },
        400
      );
    }

    await env.DB.prepare(`
      UPDATE solicitudes
      SET status = ?,
          message = ?,
          matricula = NULL,
          ci = NULL,
          claimed_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'procesando_anulacion'
    `)
      .bind(body.status, mensaje, ahora, String(body.id))
      .run();

    return respuestaJSON({ ok: true, status: body.status });
  }

  return respuestaJSON(
    { ok: false, error: "Acción no reconocida." },
    400
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ruta = url.pathname;

    try {
      if (ruta === "/api/solicitud" && request.method === "POST") {
        return await crearSolicitud(request, env);
      }

      if (
        ruta === "/api/solicitud/estado" &&
        request.method === "GET"
      ) {
        return await estadoSolicitud(url, env);
      }

      if (
        ruta === "/api/solicitud/confirmar" &&
        request.method === "POST"
      ) {
        return await confirmarAnulacion(request, env);
      }

      if (
        ruta === "/api/agente/siguiente" &&
        request.method === "GET"
      ) {
        return await siguienteTrabajo(request, env);
      }

      if (
        ruta === "/api/agente/resultado" &&
        request.method === "POST"
      ) {
        return await recibirResultado(request, env);
      }

      if (ruta.startsWith("/api/")) {
        return respuestaJSON(
          { ok: false, error: "Ruta no encontrada." },
          404
        );
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error("Error del Worker:", error);

      return respuestaJSON(
        { ok: false, error: "Error interno del Worker." },
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    const limite = Date.now() - VIDA_SOLICITUD_MS;

    ctx.waitUntil(
      env.DB.prepare(
        "DELETE FROM solicitudes WHERE created_at < ?"
      ).bind(limite).run()
    );
  }
};
