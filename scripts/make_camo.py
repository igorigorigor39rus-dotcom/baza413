"""Собственная бесшовная woodland-текстура: периодический шум + четыре цвета.
Никакие чужие фотографии или платные текстуры не используются.
"""
from pathlib import Path
import random
from PIL import Image

randomizer=random.Random(413)
grids={n:[[randomizer.uniform(-1,1) for _ in range(n)] for _ in range(n)] for n in (4,8,16)}
def noise(n,x,y):
    px=x*n/256;py=y*n/256;ix=int(px);iy=int(py);a=px-ix;b=py-iy
    a=a*a*(3-2*a);b=b*b*(3-2*b);g=grids[n]
    top=g[iy%n][ix%n]*(1-a)+g[iy%n][(ix+1)%n]*a
    bottom=g[(iy+1)%n][ix%n]*(1-a)+g[(iy+1)%n][(ix+1)%n]*a
    return top*(1-b)+bottom*b
palette=['#1d2921','#626d42','#a5a17b','#5e4834']
from PIL import ImageColor
colors=[ImageColor.getrgb(c) for c in palette]
image=Image.new('RGB',(256,256))
for y in range(256):
    for x in range(256):
        value=.65*noise(4,x,y)+.25*noise(8,x,y)+.1*noise(16,x,y)
        index=0 if value<-.24 else 1 if value<.02 else 2 if value<.22 else 3
        image.putpixel((x,y),colors[index])
image.save(Path(__file__).resolve().parent.parent/'web/assets/military-camo.png',optimize=True)
