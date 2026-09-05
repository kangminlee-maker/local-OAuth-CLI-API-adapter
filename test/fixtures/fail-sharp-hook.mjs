// A module resolve hook that makes `import('sharp')` fail the way a platform
// without a prebuilt binary makes it fail. Registered by
// `register-fail-sharp.mjs` so a child process can prove that the image path
// answers a codec it cannot load BEFORE it starts a billed backend turn.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sharp') {
    throw new Error('Could not load the "sharp" module using the test runtime');
  }
  return nextResolve(specifier, context);
}
