process.on("SIGUSR2", () => {
  const before = process.memoryUsage();
  Bun.gc(true);
  const after = process.memoryUsage();

  console.log(
    JSON.stringify({
      event: "forced_gc",
      before,
      after,
    }),
  );
});
