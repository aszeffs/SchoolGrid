import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { api } from "./api.ts";
import { navigate } from "./navigation.ts";

export function SignIn() {
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Someone already signed in has nothing to do here.
  useEffect(() => {
    let current = true;
    void api.session().then((session) => {
      if (current && session.ok) {
        navigate("/", { replace: true });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    const result = await api.signIn({
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setSubmitting(false);
    if (result.ok) {
      navigate("/", { replace: true });
    } else {
      setFailed(true);
    }
  };

  const howThisWasBuilt = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate("/how-this-was-built");
  };

  return (
    <main className="panel">
      <h1>Sign in to SchoolGrid</h1>
      <form onSubmit={submit}>
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
      <p className="muted">
        <a href="/how-this-was-built" onClick={howThisWasBuilt}>
          How this was built
        </a>
      </p>
    </main>
  );
}
