// biome-ignore lint/correctness/noUnusedVariables: CloudFront calls handler by name.
function handler(event) {
  const request = event.request;
  const host = request.headers.host ? request.headers.host.value : "";
  if (host === "fidant.se") {
    return request;
  }
  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: { location: { value: `https://fidant.se${request.uri}` } },
  };
}
