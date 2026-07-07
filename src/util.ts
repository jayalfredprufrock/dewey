/** Marks a skeleton method whose body isn't wired up yet. Returns `never` so it satisfies any return type. */
export const notImplemented = (what: string): never => {
  throw new Error(`dewey: ${what} is not implemented yet.`);
};
