"""Подготовка каталога: HTML Wikipedia, JSON Wikidata en, JSON ru, файл результата.

Запустите build_breeds.py с полученным результатом. Исходники и лицензии
указаны в web/assets/BREEDS_SOURCE.md. Сеть при работе приложения не нужна.
"""
from pathlib import Path
import json,re,html,unicodedata,sys
src=Path(sys.argv[1]).read_text();allowed=[];sections=0
# Берём перечисленные породы из списков статьи, не навигацию и не случайные
# объекты Wikidata, ошибочно размеченные как порода.
end=src.find('id="Extinct_breeds"')
if end<0:end=len(src)
for match in re.finditer(r"data-mw='([^']+)'",src[:end]):
    try:data=json.loads(html.unescape(match[1]))
    except ValueError:continue
    for part in data.get('parts',[]):
        if not isinstance(part,dict):continue
        template=part.get('template',{})
        if template.get('target',{}).get('wt','').strip().lower()!='columns-list':continue
        sections+=1
        if sections>4:continue
        for param in template.get('params',{}).values():
            for title,label in re.findall(r'\*\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]',param.get('wt','')):
                if len(title)<90:allowed.append(label or re.sub(r' \(dog\)$','',title))
allowed=list(dict.fromkeys(allowed));print('Wikipedia listed',len(allowed))
def norm(s):return re.sub(r'[^a-z0-9а-я]','',unicodedata.normalize('NFKD',re.sub(r'\([^)]*\)','',s)).encode('ascii','ignore').decode().lower())
labels={b['breed']['value'].rsplit('/',1)[-1]:b['breedLabel']['value'] for b in json.loads(Path(sys.argv[2]).read_text())['results']['bindings']}
raw=json.loads(Path(sys.argv[3]).read_text())
by_name={norm(n):n for n in allowed};out=[];matched=set();seen=set()
for b in raw['results']['bindings']:
    key=b['breed']['value'].rsplit('/',1)[-1];en=labels.get(key,'');name=b['breedLabel']['value'];aliases=b.get('breedAltLabel',{}).get('value','').split(',')
    hits=[norm(n.strip()) for n in [en,name,*aliases] if norm(n.strip()) in by_name]
    if not hits:continue
    if norm(en) in seen:continue
    seen.add(norm(en));matched.update(hits)
    b['breedAltLabel']={'type':'literal','value':', '.join(dict.fromkeys([en,*aliases]))};out.append(b)
for norm_name,name in by_name.items():
    if norm_name not in matched:
        out.append({'breed':{'value':'https://www.wikidata.org/wiki/list-'+norm_name},'breedLabel':{'value':name},'breedAltLabel':{'value':name}})
raw['results']['bindings']=out
Path(sys.argv[4]).write_text(json.dumps(raw,ensure_ascii=False))
print('Verified entries',len(out),'matched names',len(matched))
