export async function sendRoomMessage({
  homeserver,
  roomId,
  token,
  body,
  signal
}) {
  const txnId =
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const url =
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;

  const response =
    await fetch(url, {
      method: "PUT",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body
      })
    });

  if (!response.ok) {
    const text =
      await response.text()
        .catch(() => "");

    throw new Error(
      `Matrix send failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`
    );
  }
}
