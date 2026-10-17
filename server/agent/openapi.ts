/** Host-aware OpenAPI 3.1 document for agent-facing endpoints. */
export function buildOpenApi(base: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Presio",
      version: "1.0.0",
      description:
        "Upload a PDF to start a local presentation, or validate Presio sidecar attachments. See /llms.txt and /api.md.",
    },
    servers: [{ url: base }],
    paths: {
      "/api/present": {
        post: {
          summary: "Start a local presentation from a PDF (or replace an existing one)",
          description:
            "Stages the PDF and returns a url. Opening the url copies the PDF into the browser (local session), deletes the server copy, and skips the share screen. The url works until a browser claims it; unclaimed handoffs expire after 24 hours (7 days when authenticated). Pass session_id plus controller_token (the t= parameter of a previously returned url) to instead replace that presentation's deck in place — the response keeps the same id and url, and no additional concurrent-presentation slot is used.",
          operationId: "present",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: { type: "string", format: "binary", description: "PDF file" },
                    session_id: {
                      type: "string",
                      description:
                        "Id of an existing presentation to update in place (from an earlier present response) instead of creating a new one. Send at most once.",
                    },
                    controller_token: {
                      type: "string",
                      description:
                        "Controller token for that presentation — the t= query parameter of the url returned when it was created. Required whenever session_id is given; may be sent as the x-controller-token header instead.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Handoff URL",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "url", "filename", "totalSlides", "next"],
                    properties: {
                      id: { type: "string" },
                      url: {
                        type: "string",
                        format: "uri",
                        description:
                          "Handoff link: valid until a browser claims the deck, or 24h (7 days authenticated) if unclaimed. Fetching without completing handoff does not consume it. Unchanged from the original response when updating — for a deck that has been synced for sharing this is the viewer link (/s/{id}) instead, which carries no token.",
                      },
                      filename: {
                        type: "string",
                        description: "Display title — the uploaded filename with its .pdf extension stripped.",
                      },
                      totalSlides: { type: "integer" },
                      next: { type: "string" },
                      updated: {
                        type: "boolean",
                        description: "True when this call replaced an existing presentation instead of creating one.",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Missing or non-PDF file, a deck over the page limit, or session_id/controller_token sent more than once",
            },
            "401": { description: "session_id given without a controller token" },
            "403": { description: "Wrong controller token for the referenced presentation" },
            "404": { description: "Unknown or expired session_id" },
            "413": { description: "PDF exceeds the 50MB limit" },
            "422": { description: "The uploaded bytes could not be parsed as a PDF" },
          },
        },
      },
      "/api/plugins": {
        get: {
          summary: "List published plugins",
          description:
            "Public GitHub repos with the presio-plugin topic, most starred first, from a GitHub search the server caches for 5 minutes. Add one in the app by its source (or open BASE/?plugins=<source>); its manifest is read and the presenter asked to trust it then.",
          operationId: "listPlugins",
          responses: {
            "200": {
              description: "Plugins",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["plugins", "fetchedAt"],
                    properties: {
                      plugins: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["source", "id", "owner", "repo", "stars", "htmlUrl"],
                          properties: {
                            source: { type: "string", description: "github:<owner>/<repo>" },
                            id: { type: "string", description: "The plugin id it will get, e.g. alice/poll" },
                            owner: { type: "string" },
                            repo: { type: "string" },
                            description: { type: ["string", "null"] },
                            stars: { type: "integer" },
                            pushedAt: { type: ["string", "null"], format: "date-time" },
                            htmlUrl: { type: "string", format: "uri" },
                            avatarUrl: { type: ["string", "null"], format: "uri" },
                            topics: { type: "array", items: { type: "string" } },
                          },
                        },
                      },
                      fetchedAt: { type: "string", format: "date-time", description: "When GitHub was last asked" },
                    },
                  },
                },
              },
            },
            "502": { description: "GitHub couldn't be searched and nothing is cached yet" },
          },
        },
      },
      "/api/check": {
        post: {
          summary: "Validate PDF sidecar attachments",
          operationId: "check",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: {
                    file: { type: "string", format: "binary" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Check report",
              content: {
                "application/json": {
                  schema: { $ref: `${base}/schema/check-report.schema.json` },
                },
              },
            },
          },
        },
      },
      "/api/sessions/{id}/handoff": {
        get: {
          summary: "Download staged handoff PDF",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "t", in: "query", required: true, schema: { type: "string" }, description: "Controller token" },
          ],
          responses: {
            "200": {
              description: "PDF bytes",
              content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
            },
          },
        },
      },
      "/api/sessions/{id}/handoff/complete": {
        post: {
          summary: "Clear staged PDF after browser handoff",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "x-controller-token",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      "/api/sessions/mine": {
        get: {
          summary: "List the signed-in user's live synced presentations",
          description:
            "Every non-expired synced presentation owned by the authenticated user, newest first. Each row carries its controller token — the owner is entitled to it, so any device the user signs in on can open the controller. Not available in local mode.",
          operationId: "mySessions",
          parameters: [
            {
              name: "Authorization",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "Bearer Presio login JWT",
            },
          ],
          responses: {
            "200": {
              description: "Live synced presentations, newest first",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "filename", "total_slides", "controllerToken"],
                      properties: {
                        id: { type: "string" },
                        filename: { type: "string" },
                        total_slides: { type: "integer" },
                        created_at: { type: "string", format: "date-time" },
                        expires_at: { type: "string", format: "date-time" },
                        controllerToken: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Missing or invalid bearer token" },
          },
        },
      },
      "/api/sessions/{id}/remote-version": {
        get: {
          summary: "Change-detection metadata for a URL-backed deck's remote PDF",
          description:
            "Probes the deck's source URL with a HEAD request (one-byte ranged GET fallback) and returns its validator headers, so a running controller can tell whether the remote PDF was republished — without downloading it. Only for presentations backed by an external PDF URL. The probe is https-only and restricted to public addresses (loopback, private and link-local targets are refused, and redirects are re-checked at every hop).",
          operationId: "remoteSessionVersion",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "x-controller-token",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "Controller token (or Authorization: Bearer for the logged-in owner)",
            },
          ],
          responses: {
            "200": {
              description: "Validator tuple; each field is \"\" when the host does not send it",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["etag", "lastModified", "contentLength"],
                    properties: {
                      etag: { type: "string" },
                      lastModified: { type: "string" },
                      contentLength: { type: "string" },
                    },
                  },
                },
              },
            },
            "403": { description: "Wrong controller token" },
            "404": {
              description:
                "Unknown or expired session, or the presentation is not backed by an external URL (local and server-hosted decks have no pdf_url) — nothing to watch",
            },
            "502": {
              description:
                "The remote host could not be reached, or the URL is one the server refuses to fetch",
            },
          },
        },
      },
      "/api/sessions/{id}/deck-refreshed": {
        post: {
          summary: "Announce a republished URL-backed deck to the room",
          description:
            "The presenter accepted a deck that was republished at its source URL. Records the new page count, clamps the stored current slide into range, drops the stored drawings, and broadcasts deck_updated so every connected client re-fetches the source URL. No bytes are uploaded — pdf_url decks keep no server copy.",
          operationId: "deckRefreshed",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "x-controller-token",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "Controller token (or Authorization: Bearer for the logged-in owner)",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["total_slides"],
                  properties: {
                    total_slides: {
                      type: "integer",
                      description: "The republished PDF's page count, as read by the client",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      totalSlides: { type: "integer" },
                      filename: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Missing or invalid total_slides, or the presentation is not URL-backed",
            },
            "403": { description: "Wrong controller token" },
            "404": { description: "Unknown or expired session id" },
          },
        },
      },
      "/api/sessions/{id}": {
        delete: {
          summary: "End a presentation",
          description:
            "Disconnects all viewers, removes the PDF, and marks the session expired — not recoverable. Authorized by the presentation's controller token.",
          operationId: "endSession",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "x-controller-token",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
            "403": { description: "Wrong controller token" },
            "404": { description: "Unknown session id" },
          },
        },
      },
    },
  };
}
