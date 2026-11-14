// PNG fixtures and normalized bytes from image-codec (Zed image 0.25.10).
export const imageFixtures = {
  "red": {
    "raw": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=",
    "width": 2,
    "height": 1,
    "normalized": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AP8AAP//AAD/EfcD/d750N0AAAAASUVORK5CYII="
  },
  "blue": {
    "raw": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAD0lEQVR4nGNgYPjfwAAiAAyBAv++Qs8PAAAAAElFTkSuQmCC",
    "width": 1,
    "height": 2,
    "normalized": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAFUlEQVR4AQEKAPX/AAAA/4AAAAD/gAyBAv9hvl7hAAAAAElFTkSuQmCC"
  }
} as const;
export const fixtureBytes = (name: keyof typeof imageFixtures) => Uint8Array.from(atob(imageFixtures[name].raw), char => char.charCodeAt(0));
