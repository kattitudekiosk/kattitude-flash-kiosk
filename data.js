/* Sheets are served from assets/sheets/2160/: each fitted inside 2160x3840
 * (2x the 1080-wide wall, so zooming stays sharp), never cropped, never
 * upscaled. Sheet IV is cut from the 10000x10000 source in assets/originals/.
 * Sheets I and II have no larger source than 1320 wide, so they are the
 * originals unchanged. The untouched originals stay in assets/sheets/. */
const GALLERY_DATA = {
  shopName: "KATTITUDE",
  sheets: [
    {
      id: 1,
      title: "Flash Sheet I",
      file: "assets/sheets/2160/IMG_1705.JPEG"
    },
    {
      id: 2,
      title: "Flash Sheet II",
      file: "assets/sheets/2160/IMG_2120.JPEG"
    },
    {
      id: 3,
      title: "Flash Sheet III",
      file: "assets/sheets/2160/Untitled_Artwork.jpg"
    },
    {
      id: 4,
      title: "Flash Sheet IV",
      file: "assets/sheets/2160/Untitled_Artwork_2.jpg"
    }
  ]
};
