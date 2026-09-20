import { beforeEach, describe, expect, it, vi } from "vitest";

// THE OPERATOR'S THREE WRITES ON /super/data-requests, UNIT-TESTED.
//
// Review finding I6, second half: NOTHING under tests/ imported
// lib/dsr/admin-actions.ts. The psql suite proves the database (the
// transition table, the who-may-do-it rule, the handover-note constraint) and
// the permission matrix proves who may reach each RPC -- but the module that
// decides WHICH RPC is called, with what, and what a person is told when it
// refuses had no coverage at all, on either of the two actions that close a
// statutory request.
//
// WHAT IS REAL HERE: the three Server Actions, checkStepUp()
// (lib/auth/step-up-gate.ts) and the amr arithmetic under it. WHAT IS
// STUBBED: the session's claims (the input under test), the workspace lookup
// and the RPC -- so "no RPC was called" is observable, which is the whole
// point on a refusal path. The tests/unit/legal/admin-actions-step-up.test.ts
// shape, for its reasons.
//
// A stale credential is one presented more than STEP_UP_MAX_AGE_SECONDS ago;
// an e2e run cannot produce one without waiting five minutes.

const stubs = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  rpc: vi.fn(),
  /** What the organisations lookup answers with for the slug it is given. */
  organisation: null as { id: string; name: string } | null,
  lookedUpSlug: "",
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/admin/superuser", () => ({ isSuperuser: async () => true }));
vi.mock("@/lib/crm/write", () => ({ FAILED_MESSAGE: "Something went wrong." }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => ({
        data: stubs.claims ? { claims: stubs.claims } : null,
        error: null,
      }),
    },
    from: () => ({
      select: () => ({
        eq: (_column: string, value: string) => {
          stubs.lookedUpSlug = value;
          return {
            maybeSingle: async () => ({ data: stubs.organisation, error: null }),
          };
        },
      }),
    }),
    rpc: async (name: string, args: unknown) => {
      stubs.rpc(name, args);
      return { data: null, error: null };
    },
  }),
}));

import {
  addDataSubjectRequestNoteAction,
  routeDataSubjectRequestAction,
  transitionDataSubjectRequestAction,
  ROUTING_CONFIRMED_SLUG_KEY,
  ROUTING_RESOLVED_NAME_KEY,
} from "@/lib/dsr/admin-actions";
import { STEP_UP_MAX_AGE_SECONDS } from "@/lib/auth/step-up";
import { EMPTY_FORM_STATE } from "@/lib/forms";

const REQUEST = "11111111-2222-4333-8444-555555555555";
const ORG = { id: "99999999-8888-4777-8666-555555555555", name: "Neon Nights Ltd" };

function claimsAged(method: string, agoSeconds: number): Record<string, unknown> {
  return {
    sub: "00000000-0000-4000-8000-000000000001",
    aal: "aal2",
    amr: [{ method, timestamp: Math.floor(Date.now() / 1000) - agoSeconds }],
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeEach(() => {
  stubs.rpc.mockReset();
  stubs.claims = claimsAged("totp", 5);
  stubs.organisation = ORG;
  stubs.lookedUpSlug = "";
});

describe("moving a request through its states", () => {
  it("calls the THREE-argument RPC, and names no workspace", async () => {
    // The four-argument signature was dropped when routing got its own
    // function (fix round 1): a call carrying p_route_to_organisation_id
    // would now be PostgREST's "no such function", at runtime, on the one
    // page where a failed write is a missed statutory deadline.
    const result = await transitionDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      form({ requestId: REQUEST, status: "in_progress" }),
    );
    expect(result.error).toBeUndefined();
    expect(result.message).toBe("Marked Being worked on.");
    expect(stubs.rpc).toHaveBeenCalledWith("transition_data_subject_request", {
      p_request_id: REQUEST,
      p_status: "in_progress",
      p_rejection_reason: null,
    });
  });

  it("refuses `withdrawn` by name: it is the requester's act alone", async () => {
    const result = await transitionDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      form({ requestId: REQUEST, status: "withdrawn" }),
    );
    expect(result.error).toMatch(/Only the person who made a request/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("refuses `routed` by name and points at the form that records the handover", async () => {
    const result = await transitionDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      form({ requestId: REQUEST, status: "routed" }),
    );
    expect(result.error).toMatch(/own form, which records the handover/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("refuses an unknown status and a malformed id without a round trip", async () => {
    for (const bad of [
      { requestId: REQUEST, status: "closed" },
      { requestId: "not-a-uuid", status: "fulfilled" },
    ]) {
      expect((await transitionDataSubjectRequestAction(EMPTY_FORM_STATE, form(bad))).error)
        .toBeTruthy();
    }
    expect(stubs.rpc).not.toHaveBeenCalled();
  });
});

describe("refusing a statutory request needs a fresh credential and a reason", () => {
  const refusal = () =>
    form({ requestId: REQUEST, status: "rejected", rejectionReason: "Not our data to erase." });

  it("STALE: a TOTP presented just outside the window refuses nothing", async () => {
    stubs.claims = claimsAged("totp", STEP_UP_MAX_AGE_SECONDS + 1);
    const result = await transitionDataSubjectRequestAction(EMPTY_FORM_STATE, refusal());
    expect(result.error).toMatch(/Confirm it’s you/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("STALE: a magic-link session, however recent, is not step-up", async () => {
    stubs.claims = claimsAged("otp", 2);
    const result = await transitionDataSubjectRequestAction(EMPTY_FORM_STATE, refusal());
    expect(result.error).toMatch(/Confirm it’s you/);
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("FRESH but reasonless: refused, with the message beside the field", async () => {
    const result = await transitionDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      form({ requestId: REQUEST, status: "rejected", rejectionReason: "   " }),
    );
    expect(result.error).toBe("A refusal must say why.");
    expect(result.fieldErrors?.rejectionReason).toBeTruthy();
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: fresh and reasoned, the refusal is recorded with its reason", async () => {
    const result = await transitionDataSubjectRequestAction(EMPTY_FORM_STATE, refusal());
    expect(result.error).toBeUndefined();
    expect(result.message).toBe("Marked Refused.");
    expect(stubs.rpc).toHaveBeenCalledWith("transition_data_subject_request", {
      p_request_id: REQUEST,
      p_status: "rejected",
      p_rejection_reason: "Not our data to erase.",
    });
  });
});

describe("passing a request to the workspace that is its controller (Q160)", () => {
  const routing = (extra: Record<string, string> = {}) =>
    form({
      requestId: REQUEST,
      organisationSlug: "neon-nights",
      handoverNote: "Emailed owner@neon.test on 19 Sept.",
      ...extra,
    });

  it("writes NOTHING on the first press: it resolves the slug and hands back the NAME", async () => {
    const result = await routeDataSubjectRequestAction(EMPTY_FORM_STATE, routing());
    expect(stubs.lookedUpSlug).toBe("neon-nights");
    expect(stubs.rpc, "a routing was written before the operator confirmed the workspace")
      .not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.message).toBeUndefined();
    expect(result.values?.[ROUTING_RESOLVED_NAME_KEY]).toBe(ORG.name);
    expect(result.values?.[ROUTING_CONFIRMED_SLUG_KEY]).toBe("neon-nights");
  });

  it("writes on the second press, and says that nothing was sent to anybody", async () => {
    const result = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({ [ROUTING_CONFIRMED_SLUG_KEY]: "neon-nights" }),
    );
    expect(stubs.rpc).toHaveBeenCalledWith("route_data_subject_request", {
      p_request_id: REQUEST,
      p_organisation_id: ORG.id,
      p_handover_note: "Emailed owner@neon.test on 19 Sept.",
    });
    expect(result.message).toContain(ORG.name);
    expect(
      result.message,
      "the operator must be told the product sent nothing -- it is the whole of Q160a",
    ).toMatch(/Nothing was sent/);
  });

  it("RE-ASKS when the slug has changed since it was confirmed", async () => {
    // The typo case the confirmation exists for: a confirmation carried over
    // from one workspace must not authorise a write to another.
    const result = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({ organisationSlug: "neon-nightz", [ROUTING_CONFIRMED_SLUG_KEY]: "neon-nights" }),
    );
    expect(stubs.rpc).not.toHaveBeenCalled();
    expect(result.values?.[ROUTING_CONFIRMED_SLUG_KEY]).toBe("neon-nightz");
  });

  it("refuses a routing with no handover note, before it looks anything up", async () => {
    const data = routing();
    data.set("handoverNote", "  ");
    const result = await routeDataSubjectRequestAction(EMPTY_FORM_STATE, data);
    expect(result.error).toMatch(/Say how you told the workspace/);
    expect(result.fieldErrors?.handoverNote).toBeTruthy();
    expect(stubs.rpc).not.toHaveBeenCalled();
    expect(stubs.lookedUpSlug, "an unroutable submission still cost a lookup").toBe("");
  });

  it("refuses an empty slug and an unknown one, and writes nothing either way", async () => {
    const blank = routing();
    blank.set("organisationSlug", "");
    expect((await routeDataSubjectRequestAction(EMPTY_FORM_STATE, blank)).fieldErrors
      ?.organisationSlug).toBeTruthy();

    stubs.organisation = null;
    const unknown = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({ [ROUTING_CONFIRMED_SLUG_KEY]: "neon-nights" }),
    );
    expect(unknown.error).toBe("No workspace has that slug.");
    expect(stubs.rpc).not.toHaveBeenCalled();
  });

  it("lower-cases the typed slug, so a capitalised one still matches", async () => {
    await routeDataSubjectRequestAction(EMPTY_FORM_STATE, routing({ organisationSlug: "Neon-Nights" }));
    expect(stubs.lookedUpSlug).toBe("neon-nights");
  });
});

describe("an internal note", () => {
  it("is refused when empty, and written when it is not", async () => {
    const empty = await addDataSubjectRequestNoteAction(
      EMPTY_FORM_STATE,
      form({ requestId: REQUEST, note: "   " }),
    );
    expect(empty.fieldErrors?.note).toBeTruthy();
    expect(stubs.rpc).not.toHaveBeenCalled();

    const written = await addDataSubjectRequestNoteAction(
      EMPTY_FORM_STATE,
      form({ requestId: REQUEST, note: "Checked the audit trail." }),
    );
    expect(written.message).toMatch(/never sees it/);
    expect(stubs.rpc).toHaveBeenCalledWith("add_data_subject_request_note", {
      p_request_id: REQUEST,
      p_body: "Checked the audit trail.",
    });
  });
});
