import net from "node:net";

/*
 * A TCP proxy between one core and Postgres, for chaos tests.
 *
 *   proxy.cut()        drop every connection and refuse new ones
 *                      (a Postgres failover or restart)
 *   proxy.partition()  keep connections open but forward nothing,
 *                      and accept new ones without forwarding (a
 *                      network partition: packets vanish)
 *   proxy.heal()       back to normal; a partition resumes the
 *                      held connections, like a healed network
 */
export async function startProxy({ host, port }) {
  const pairs = new Set();
  let mode = "open";

  const server = net.createServer(client => {
    if (mode === "cut") {
      client.destroy();
      return;
    }

    const upstream = net.connect({ host, port });
    const pair = { client, upstream };
    pairs.add(pair);

    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);

    client.on("data", chunk => {
      if (mode === "partition") pair.heldUp = [...(pair.heldUp ?? []), chunk];
      else upstream.write(chunk);
    });
    upstream.on("data", chunk => {
      if (mode === "partition") pair.heldDown = [...(pair.heldDown ?? []), chunk];
      else client.write(chunk);
    });
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,

    cut() {
      mode = "cut";
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      pairs.clear();
    },

    partition() {
      mode = "partition";
    },

    heal() {
      mode = "open";
      for (const pair of pairs) {
        for (const chunk of pair.heldUp ?? []) pair.upstream.write(chunk);
        for (const chunk of pair.heldDown ?? []) pair.client.write(chunk);
        pair.heldUp = [];
        pair.heldDown = [];
      }
    },

    async close() {
      this.cut();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
