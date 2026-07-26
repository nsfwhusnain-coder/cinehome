process.on("SIGUSR2", () => {
  const before = process.memoryUsage();
  if (typeof global.gc === "function") {
    global.gc();
  }
  const after = process.memoryUsage();

  console.log(
    JSON.stringify({
      event: "forced_gc",
      before,
      after,
    }),
  );
});
