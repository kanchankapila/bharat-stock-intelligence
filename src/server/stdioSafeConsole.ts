const writeToStderr = (...args: unknown[]) => {
  const message = args
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .join(" ");
  process.stderr.write(`${message}\n`);
};

console.log = writeToStderr;
console.info = writeToStderr;
console.debug = writeToStderr;
