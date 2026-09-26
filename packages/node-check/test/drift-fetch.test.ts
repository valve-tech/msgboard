import { describe, expect, it } from "vitest";

import { gitAuthEnv } from "../src/drift-fetch.js";

const remote = "https://gitlab.com/pulsechaincom/erigon.git";

describe("gitAuthEnv", () => {
  it("adds nothing without a token, so local runs stay anonymous", () => {
    expect(gitAuthEnv({ remote })).toEqual({});
    expect(gitAuthEnv({ remote, token: "" })).toEqual({});
  });

  it("scopes a Basic oauth2 header to the remote origin", () => {
    const env = gitAuthEnv({ remote, token: "glpat-abc" });
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://gitlab.com/.extraHeader");
    const basic = env.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", "");
    expect(Buffer.from(basic, "base64").toString()).toBe("oauth2:glpat-abc");
  });

  it("never puts the raw token in a value a log would show", () => {
    const env = gitAuthEnv({ remote, token: "glpat-abc" });
    for (const v of Object.values(env)) expect(v).not.toContain("glpat-abc");
  });
});
