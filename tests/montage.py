# 스크린샷 몽타주: python3 montage.py out.png a.png b.png ... (열 4개)
import sys
from PIL import Image
out, files = sys.argv[1], sys.argv[2:]
cols = 4
ims = [Image.open(f).convert('RGB') for f in files]
tw = 300; th = int(ims[0].height * tw / ims[0].width)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * th), (30, 30, 30))
for i, im in enumerate(ims):
    sheet.paste(im.resize((tw, th)), ((i % cols) * tw, (i // cols) * th))
sheet.save(out)
print(out, sheet.size)
