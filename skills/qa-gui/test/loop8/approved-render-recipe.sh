#!/bin/sh
set -eu

# Frozen oracle for the owner-approved V8.2 golden only.
# Product code must still derive geometry and copy from its input findings; it
# must not special-case this fixture or copy the golden output.

ORACLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE="$ORACLE_DIR/corpus/phone-320.png"
FONT_REGULAR="$ORACLE_DIR/corpus/fonts/noto-sans/NotoSans-Regular.ttf"
FONT_BOLD="$ORACLE_DIR/corpus/fonts/noto-sans/NotoSans-Bold.ttf"
EXPECTED_SOURCE_SHA='0765c68bc3bafdb4256210d64de29d7f1b2eb3007c81c2e5f731fadfc3adc895'

if [ "$#" -ne 1 ]; then
  echo 'usage: approved-render-recipe.sh OUTPUT.png' >&2
  exit 64
fi

OUTPUT=$1
if [ -e "$OUTPUT" ]; then
  echo "refusing to overwrite: $OUTPUT" >&2
  exit 73
fi

ACTUAL_SOURCE_SHA=$(shasum -a 256 "$SOURCE" | awk '{print $1}')
if [ "$ACTUAL_SOURCE_SHA" != "$EXPECTED_SOURCE_SHA" ]; then
  echo "source hash mismatch: $ACTUAL_SOURCE_SHA" >&2
  exit 65
fi

# Pixel box derives only from the detector bbox and DPR=3:
# floor(x*dpr)=512, floor(y*dpr)=1315, ceil(right*dpr)=861,
# ceil(bottom*dpr)=1448. The visible stroke expands outward.
magick \
  -size 960x2680 xc:'#FFFFFF' \
  "$SOURCE" -geometry +0+0 -composite \
  -fill '#FFFFFF' -stroke '#D0D5DD' -strokewidth 2 \
  -draw 'rectangle 0,2220 959,2679' \
  -fill none -stroke '#D92D20' -strokewidth 9 \
  -draw 'roundrectangle 503,1306 870,1457 18,18' \
  -fill '#D92D20' -stroke '#FFFFFF' -strokewidth 6 \
  -draw 'circle 503,1306 535,1306' \
  -font "$FONT_BOLD" -pointsize 32 -fill '#FFFFFF' -stroke none -gravity NorthWest \
  -annotate +493+1284 '1' \
  -fill '#D92D20' -stroke none \
  -draw 'circle 64,2300 94,2300' \
  -font "$FONT_BOLD" -pointsize 30 -fill '#FFFFFF' -gravity NorthWest \
  -annotate +54+2279 '1' \
  -font "$FONT_BOLD" -pointsize 30 -fill '#B42318' \
  -annotate +112+2267 'HIGH · UNINTENDED-TEXT-OVERFLOW' \
  -font "$FONT_REGULAR" -pointsize 25 -fill '#101828' \
  -annotate +64+2345 'Liên kết div > a.inline-flex tràn 8 CSS px sang phải' \
  -annotate +64+2388 '(287 so với 279), làm bố cục 320 px bị lệch.' \
  -annotate +64+2431 'Thu gọn chiều rộng hoặc cho phép nội dung xuống dòng.' \
  -font "$FONT_REGULAR" -pointsize 21 -fill '#475467' \
  -annotate +64+2520 'BBOX  x=170.9609375 · y=438.5 · w=116.0390625 · h=44 · DPR=3' \
  -annotate +64+2563 'Nguồn: detector DOM · viewport 320×740 CSS px · selector div > a.inline-flex' \
  -strip -define png:exclude-chunk=date,time \
  "$OUTPUT"
