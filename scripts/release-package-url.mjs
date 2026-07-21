export function packageUrl(item) {
  const name = item.name
    .split("/")
    .map(encodePurlComponent)
    .join("/");
  return `pkg:${encodePurlComponent(item.ecosystem)}/${name}@${encodePurlComponent(item.version)}`;
}

function encodePurlComponent(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.codePointAt(0).toString(16).toUpperCase()}`);
}
