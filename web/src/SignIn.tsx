import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { Link } from "./Link.tsx";
import { navigate } from "./navigation.ts";
import { Key, Sheet } from "./Sheet.tsx";

export function SignIn() {
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Someone already signed in has nothing to do here.
  useEffect(() => {
    let current = true;
    void api.session().then((session) => {
      if (current && session.ok) {
        navigate({ name: "schools" }, { replace: true });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const signIn = async (credentials: { username: string; password: string }) => {
    setSubmitting(true);
    const result = await api.signIn(credentials);
    setSubmitting(false);
    if (result.ok) {
      navigate({ name: "schools" }, { replace: true });
    } else {
      setFailed(true);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void signIn({
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
    });
  };

  const legend = (
    <>
      <h2>Key</h2>
      <p>Signing in to SchoolGrid.</p>
      <dl>
        <Key term="User account">
          One User account, which may reach more than one School. It holds no role and no academic record of its own.
        </Key>
        <Key term="Refusals">
          Every refused sign-in is answered the same way, whatever went wrong. Nothing here says which.
        </Key>
      </dl>
    </>
  );

  return (
    <Sheet
      name="Sign in"
      legend={legend}
      foot={
        <p className="muted">
          <Link to={{ name: "howThisWasBuilt" }}>
            How this was built
          </Link>
        </p>
      }
    >
      <h1>Sign in to SchoolGrid</h1>
      {/*
        What the visitor is signing in to, before they are asked for anything.
        Said in the glossary's own terms, because those are the words every
        sheet beyond this one is struck in.
      */}
      <p>
        SchoolGrid is a K-12 academic records system for a School. One School owns its Persons, its
        Class Offerings and every record about them, and nothing is shared between Schools.
      </p>
      <p>
        One User account signs in here. It holds no role of its own: what it reaches is whichever Person
        it resolves to in each School, and the School memberships that Person holds.
      </p>
      <form className="panel" onSubmit={submit}>
        <label>
          Username
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {/*
          One message whatever went wrong: an unknown username, a wrong
          password, a throttled attempt or a server error. The API refuses the
          first two alike (ADR-0002), and the page does not tell any of them
          apart, so it cannot explain a refusal the API did not.
        */}
        {failed && (
          <p role="alert" className="error">
            Sign-in did not work. Check your details and try again.
          </p>
        )}
        <button type="submit" disabled={submitting}>
          Sign in
        </button>
      </form>
    </Sheet>
  );
}
