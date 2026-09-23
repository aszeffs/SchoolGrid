import { useEffect, useState } from "react";
import { api, type BuildInfo } from "./api.ts";
import { Link } from "./Link.tsx";
import { Key, Sheet, type SheetKind } from "./Sheet.tsx";

/** Which sheet this page is, named once so the two states cannot drift apart. */
const SHEET: SheetKind = { name: "How this was built" };

const REPOSITORY = "aszeffs/SchoolGrid";
const IMAGE = "ghcr.io/aszeffs/schoolgrid";
const GITHUB = `https://github.com/${REPOSITORY}`;
/** The branch published images are built from, and so the only ref a signature here can carry. */
const RELEASE_BRANCH = "main";

/**
 * The command the README gives for checking an image's provenance, for this
 * digest. Pinned to the commit as well when it is known, so a pass means this
 * exact commit on the release branch built these exact bytes.
 *
 * The ref is fixed: a digest reaches this page only from a deploy, and only
 * images built from the release branch are published. The prose above the
 * command says so, so an image from anywhere else fails the check visibly
 * rather than looking unverifiable.
 */
function verifyCommand({ digest, commit }: { digest: string; commit?: string | undefined }): string {
  return [
    `gh attestation verify oci://${IMAGE}@${digest}`,
    `--repo ${REPOSITORY}`,
    `--signer-workflow ${REPOSITORY}/.github/workflows/container.yml`,
    `--source-ref refs/heads/${RELEASE_BRANCH}`,
    ...(commit === undefined ? [] : [`--source-digest ${commit}`]),
    "--deny-self-hosted-runners",
  ].join(" \\\n  ");
}

type State = { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; build: BuildInfo };

/**
 * What the running site was built from, and how to check it. Public: it needs
 * no session and shows nothing about any School.
 *
 * A value the server does not know is said to be unknown, never filled with a
 * placeholder, so nothing here looks checkable that is not. When the server
 * does not answer at all, the explanation still stands: what every image goes
 * through is true of this site whether or not it can name its own build.
 */
export function HowThisWasBuilt() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void api.buildInfo().then((result) => {
      if (current) {
        setState(result.ok ? { kind: "ready", build: result.body } : { kind: "unavailable" });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  if (state.kind === "loading") {
    return <Sheet {...SHEET} busy />;
  }

  const build = state.kind === "ready" ? state.build : undefined;
  const digest = build?.digest;
  const commit = build?.commit;

  const legend = (
    <>
      <h2>Key</h2>
      <p>What the running site was built from, and how to check it yourself.</p>
      <dl>
        <Key term="Digest">
          A hash of an image&apos;s contents. Unlike a tag, it cannot be moved to point at something else later.
        </Key>
        <Key term="Attestation">
          A signed record of the workflow and source that produced an image, checkable by anyone.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet
      {...SHEET}
      legend={legend}
      foot={
        <p>
          <Link to={{ name: "schools" }}>
            Go to SchoolGrid
          </Link>
        </p>
      }
    >
      <h1>How this was built</h1>
      <p>
        Nothing here asks to be taken on trust. Every SchoolGrid image goes through the same run, this
        server names the one it is running, and the command at the foot checks that claim against the
        signature rather than against this page.
      </p>

      <h2>What every image goes through</h2>
      <ol>
        <li>Every change is tested before it merges.</li>
        <li>
          On a merge to <code>{RELEASE_BRANCH}</code>, GitHub Actions builds one container image and never
          rebuilds it.
        </li>
        <li>Those same bytes are scanned for known vulnerabilities.</li>
        <li>Those same bytes are started against a real database and driven in a browser.</li>
        <li>Only an image that passed all of it is published, signed with the workflow and commit that built it.</li>
      </ol>
      <p>
        An image&apos;s digest is a hash of its contents, so a digest names exactly one set of bytes and
        cannot be moved to another later.
      </p>

      <h2>What this site is running</h2>
      {build === undefined ? (
        <p className="muted">
          This server did not say what it is running, so there is nothing here to check. Everything above is
          still true of the image it was built from.
        </p>
      ) : (
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
      )}

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
            this repository's workflow built this image from <code>{RELEASE_BRANCH}</code>
            {commit === undefined ? "" : ", at this commit"}:
          </p>
          <pre aria-label="Verify command">
            <code>{verifyCommand({ digest, commit })}</code>
          </pre>
        </>
      )}
    </Sheet>
  );
}
