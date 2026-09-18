import { useEffect, useState, type MouseEvent } from "react";
import { api, type BuildInfo } from "./api.ts";
import { navigate } from "./navigation.ts";
import { NotAvailable } from "./NotAvailable.tsx";

const REPOSITORY = "aszeffs/SchoolGrid";
const IMAGE = "ghcr.io/aszeffs/schoolgrid";
const GITHUB = `https://github.com/${REPOSITORY}`;

/**
 * The command the README gives for checking an image's provenance, for this
 * digest. Pinned to the commit as well when it is known, so a pass means this
 * exact commit on `main` built these exact bytes.
 */
function verifyCommand({ digest, commit }: { digest: string; commit?: string | undefined }): string {
  return [
    `gh attestation verify oci://${IMAGE}@${digest}`,
    `--repo ${REPOSITORY}`,
    `--signer-workflow ${REPOSITORY}/.github/workflows/container.yml`,
    "--source-ref refs/heads/main",
    ...(commit === undefined ? [] : [`--source-digest ${commit}`]),
    "--deny-self-hosted-runners",
  ].join(" \\\n  ");
}

type State = { kind: "loading" } | { kind: "not-available" } | { kind: "ready"; build: BuildInfo };

/**
 * What the running site was built from, and how to check it. Public: it needs
 * no session and shows nothing about any School.
 *
 * A value the server does not know is said to be unknown, never filled with a
 * placeholder, so nothing here looks checkable that is not.
 */
export function HowThisWasBuilt() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void api.buildInfo().then((result) => {
      if (current) {
        setState(result.ok ? { kind: "ready", build: result.body } : { kind: "not-available" });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const home = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate("/");
  };

  switch (state.kind) {
    case "loading":
      return <main className="panel" aria-busy="true" />;
    case "not-available":
      return <NotAvailable />;
    case "ready": {
      const { commit, digest } = state.build;
      return (
        <main className="panel wide">
          <h1>How this was built</h1>
          <p>
            Every change to SchoolGrid is tested before it merges. On a merge to <code>main</code>,
            GitHub Actions builds one container image and never rebuilds it: those same bytes are scanned for known
            vulnerabilities, started against a real database, and driven in a browser. Only an image that passes
            all of it is published, and it is signed with a record of the workflow and commit that built it.
            An image's digest is a hash of its contents, so the digest below names exactly those bytes, and the
            command further down lets you check that signature against them yourself.
          </p>

          <h2>What this site is running</h2>
          <dl className="facts">
            <dt>Commit</dt>
            <dd>
              {commit === undefined ? (
                <span className="muted">Not recorded. This server was built without a commit, as in local development.</span>
              ) : (
                <a href={`${GITHUB}/commit/${commit}`}>
                  <code>{commit}</code>
                </a>
              )}
            </dd>
            <dt>Image digest</dt>
            <dd>
              {digest === undefined ? (
                <span className="muted">
                  Not recorded. This server was not deployed from a published image, so there is nothing to verify.
                </span>
              ) : (
                <code>{digest}</code>
              )}
            </dd>
          </dl>

          <h2>Check it yourself</h2>
          <ul>
            <li>
              <a href={`${GITHUB}/pkgs/container/schoolgrid`}>The published images on GitHub Container Registry</a>
            </li>
            <li>
              <a href={`${GITHUB}/attestations`}>The signed build attestations</a>
            </li>
          </ul>
          {digest === undefined ? (
            <p className="muted">With no image digest, there is no command to verify this server with.</p>
          ) : (
            <>
              <p>
                With the <a href="https://cli.github.com/">GitHub CLI</a> signed in to any account, this checks that
                this repository's workflow built this image{commit === undefined ? "" : " from this commit"}:
              </p>
              <pre aria-label="Verify command">
                <code>{verifyCommand({ digest, commit })}</code>
              </pre>
            </>
          )}

          <p>
            <a href="/" onClick={home}>
              Go to SchoolGrid
            </a>
          </p>
        </main>
      );
    }
  }
}
