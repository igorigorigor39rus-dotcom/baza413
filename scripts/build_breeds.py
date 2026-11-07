"""Сборка офлайн-каталога из сохранённого ответа Wikidata (CC0).

Сеть нужна только для обновления исходного списка. Приложение читает наш JSON.
"""
from pathlib import Path
import json,re,sys
ROOT=Path(__file__).resolve().parent.parent

def family(name):
    rules=[('hairless',r'голая|hairless|xolo|китайская хохлат|chinese crested'),('curly',r'пудел|poodle|барбет|бишон|bichon|болонь|maltipoo|cockapoo|мальтип|кокап'),('long',r'такс|dachshund|бассет|basset|древер|drever'),('bat',r'француз.*бульдог|french bulldog|бостон|boston terrier'),('flat',r'мопс|pug|пекинес|pekingese|английский бульдог|english bulldog|брабансон'),('sighthound',r'борз|greyhound|whippet|уиппет|салюки|saluki|леврет|azawakh|азавак|sloughi|deerhound|волкодав'),('spitz',r'шпиц|spitz|сиба|шиба|shiba|акит|akita|хаски|husky|лайка|laika|самоед|samoyed|malamute|маламут|chow|чау|померан|corgi|корги|basenji|басенджи|chihuahua|чихуа|klee kai|кли кай|джиндо|чиндо|shikoku|сикоку|hokkaido|хоккайдо|динго|dingo|евразиер|eurasier|buhund|бухунд|лаппхунд|lapphund|bengal|bangkaew|бангку'),('shepherd',r'овчарк|shepherd|berger|малинуа|лакенуа|шипперке|влчак|wolfdog|колли|collie|cattle|келпи|kelpie|bouvier|бувье|хилер|heeler'),('retriever',r'лабрад|labrad|ретрив|retriev'),('spaniel',r'спаниел|spaniel|сеттер|setter|мальтез|maltese|ши-тцу|shih tzu'),('mastiff',r'мастиф|mastiff|dogue|дог\b|dane|кане|corso|ротвей|rottweiler|боксер|boxer|ньюфаунд|newfoundland|сенбер|bernard|фила|fila|sennenhund|зенненхунд|горная|mountain|кувас|kuvasz|леонбергер|leonberger|landseer|ландсир|шарпей|shar pei'),('terrier',r'терьер|terrier|шнауц|schnauzer|пинчер|pinscher|добер|doberman|ratter|ratero|крысарик|ра́тер'),('hound',r'гонч|hound|бигл|beagle|далмат|dalmat|пойнтер|pointer|бракк|braque|легав')]
    for value,pattern in rules:
        if re.search(pattern,name,re.I):return value
    return 'generic'

def main():
    raw=json.loads(Path(sys.argv[1]).read_text())['results']['bindings'];out=[]
    for row in raw:
        key=row['breed']['value'].rsplit('/',1)[-1];name=row['breedLabel']['value'].strip()
        if re.fullmatch(r'Q\d+',name) or len(name)>90:continue
        # Удаляем бессмысленные/чрезмерно длинные синонимы из внешнего источника.
        aliases=[a.strip() for a in row.get('breedAltLabel',{}).get('value','').split(',') if 1<len(a.strip())<=90][:12]
        out.append({'id':key,'name':name[:1].upper()+name[1:],'aliases':aliases,'family':family(' '.join([name,*aliases]))})
    out.append({'id':'mixed','name':'Метис / дворняжка','aliases':['беспородная','дворовая','mixed breed','дворняга'],'family':'generic'})
    out.sort(key=lambda b:(not bool(re.search('[А-Яа-яЁё]',b['name'])),b['name'].casefold()))
    dest=ROOT/'web/assets/breeds.json';dest.write_text(json.dumps(out,ensure_ascii=False,separators=(',',':'))+'\n')
    (ROOT/'web/assets/BREEDS_SOURCE.md').write_text('Названия и синонимы пород: Wikidata, лицензия CC0. Снимок от 7 ноября 2026 года.\nИсточник: https://www.wikidata.org/wiki/Wikidata:Licensing\nЗапрос: экземпляры класса «порода собак» Q39367 и его подклассов; подписи ru,en.\nКаталог сверен со списком существующих пород https://en.wikipedia.org/wiki/List_of_dog_breeds (названия, CC BY-SA); включает местные и редкие названия. Это открытый справочник, не единый международный реестр признания пород; для отсутствующего названия доступен собственный ввод.\nСтилизованные персонажи формируются из общих анатомических признаков; это игровые иллюстрации.\n')
    print('Breed entries:',len(out))
if __name__=='__main__':main()
