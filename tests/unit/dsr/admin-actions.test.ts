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
} from "@/lib/dsr/admin-actions";
// NOT from the action module: it carries "use server", which may export only
// async functions — see the comment on these two in lib/dsr/contract.ts. This
// import is also the census that keeps them out of there, because importing
// them from the action module here is exactly what hid the broken build.
import {
  ROUTING_CONFIRMATION_TOKEN_KEY,
  ROUTING_CONFIRMED_SLUG_KEY,
  ROUTING_RESOLVED_NAME_KEY,
} from "@/lib/dsr/contract";
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
    expect(
      result.values?.[ROUTING_CONFIRMATION_TOKEN_KEY],
      "the first press must MINT the confirmation the second one is accepted on (R3)",
    ).toBeTruthy();
  });

  it("writes on the second press, and says that nothing was sent to anybody", async () => {
    const first = await routeDataSubjectRequestAction(EMPTY_FORM_STATE, routing());
    const result = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({
        [ROUTING_CONFIRMATION_TOKEN_KEY]: first.values?.[ROUTING_CONFIRMATION_TOKEN_KEY] ?? "",
      }),
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
    const first = await routeDataSubjectRequestAction(EMPTY_FORM_STATE, routing());
    stubs.organisation = { id: "0f2e1c6a-9f4a-4a2b-9e7c-11111111aaaa", name: "Neon Nightz Ltd" };
    const result = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({
        organisationSlug: "neon-nightz",
        [ROUTING_CONFIRMATION_TOKEN_KEY]: first.values?.[ROUTING_CONFIRMATION_TOKEN_KEY] ?? "",
      }),
    );
    expect(stubs.rpc).not.toHaveBeenCalled();
    expect(result.values?.[ROUTING_CONFIRMED_SLUG_KEY]).toBe("neon-nightz");
  });

  // ========================================================================
  // R3 (fix round 2, Q163): THE CONFIRMATION IS THE SERVER'S, AND IT NAMES
  // THE ORGANISATION RATHER THAN THE STRING.
  // ========================================================================

  it("a single crafted POST cannot route: the confirmation is not a field the caller can write", async () => {
    // The whole of the first cut's gate was `confirmedSlug === organisationSlug`
    // WITHIN ONE SUBMISSION, so this exact form data routed at once with the
    // workspace's name never rendered to anybody.
    const result = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({
        [ROUTING_CONFIRMED_SLUG_KEY]: "neon-nights",
        [ROUTING_CONFIRMATION_TOKEN_KEY]: "neon-nights",
      }),
    );
    expect(
      stubs.rpc,
      "a crafted submission routed a statutory request with no confirmation ever shown",
    ).not.toHaveBeenCalled();
    expect(result.values?.[ROUTING_RESOLVED_NAME_KEY]).toBe(ORG.name);
  });

  it("nor can a plausible forgery: the token is HMACed, not merely structured", async () => {
    const forged = `${Date.now()}.${"a".repeat(64)}`;
    const result = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({ [ROUTING_CONFIRMATION_TOKEN_KEY]: forged }),
    );
    expect(stubs.rpc).not.toHaveBeenCalled();
    expect(result.values?.[ROUTING_CONFIRMATION_TOKEN_KEY]).not.toBe(forged);
  });

  it("RE-ASKS when the SAME slug now resolves to a DIFFERENT workspace", async () => {
    // The hole the old gate had that its own comment denied: it bound the
    // typed STRING, so a slug reassigned between the two presses -- a rename,
    // a slug freed and taken -- routed to a workspace whose name was never
    // shown. The token binds the organisation ID.
    const first = await routeDataSubjectRequestAction(EMPTY_FORM_STATE, routing());
    expect(first.values?.[ROUTING_RESOLVED_NAME_KEY]).toBe(ORG.name);

    stubs.organisation = { id: "0f2e1c6a-9f4a-4a2b-9e7c-222222bbbbbb", name: "Someone Else Ltd" };
    const second = await routeDataSubjectRequestAction(
      EMPTY_FORM_STATE,
      routing({
        [ROUTING_CONFIRMATION_TOKEN_KEY]: first.values?.[ROUTING_CONFIRMATION_TOKEN_KEY] ?? "",
      }),
    );
    expect(
      stubs.rpc,
      "the slug resolved elsewhere and the confirmation still authorised the write",
    ).not.toHaveBeenCalled();
    expect(second.values?.[ROUTING_RESOLVED_NAME_KEY]).toBe("Someone Else Ltd");
  });

  it("a confirmation minted for ONE request does not route ANOTHER", async () => {
    const first = await routeDataSubjectRequestAction(EMPTY_FORM_STATE, routing());
    const other = routing({
      [ROUTING_CONFIRMATION_TOKEN_KEY]: first.values?.[ROUTING_CONFIRMATION_TOKEN_KEY] ?? "",
    });
    other.set("requestId", "3f9a1b2c-4d5e-4f60-8a1b-999999999999");
    const result = await routeDataSubjectRequestAction(EMPTY_FORM_STATE, other);
    expect(stubs.rpc).not.toHaveBeenCalled();
    expect(result.message).toBeUndefined();
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
      routing({ [ROUTING_CONFIRMATION_TOKEN_KEY]: "anything" }),
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
