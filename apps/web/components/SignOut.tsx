export function SignOut() {
  return (
    <form action="/api/auth/logout" method="post">
      <button className="btn quiet">Sign out</button>
    </form>
  );
}
