const fs = require('fs');

const appliancesNames = ["Духовка электрическая", "Стиральная машина", "Холодильник", "Микроволновая печь", "Пылесос", "Утюг", "Блендер стационарный", "Планетарный миксер", "Мясорубка электрическая", "Чайник электрический", "Мультиварка", "Кухонный комбайн", "Кофемашина", "Тостер", "Соковыжималка"];
const dishesNames = ["Набор кастрюль", "Сковорода гриль", "Тарелка керамическая", "Набор столовых приборов", "Чайный сервиз", "Кружка фарфоровая", "Набор кухонных ножей", "Доска разделочная бамбуковая", "Стеклянная форма для запекания", "Салатница", "Терка универсальная", "Дуршлаг силиконовый", "Заварочный чайник", "Набор бокалов", "Контейнеры для хранения"];
const homeNames = ["Комплект постельного белья", "Полотенце махровое", "Ортопедическая подушка", "Одеяло стеганое", "Мягкий коврик", "Плотные шторы", "Настольная LED лампа", "Настенные часы", "Декоративная ваза", "Зеркало с подсветкой", "Корзина для белья", "Текстильный органайзер", "Теплый плед", "Декоративная подушка", "Гладильная доска"];

let products = JSON.parse(fs.readFileSync('products.json', 'utf8'));

let applianceIndex = 0;
let dishIndex = 0;
let homeIndex = 0;

products.forEach(p => {
    if (p.category === 'appliances') {
        p.name = appliancesNames[applianceIndex % appliancesNames.length];
        applianceIndex++;
    } else if (p.category === 'dishes') {
        p.name = dishesNames[dishIndex % dishesNames.length];
        dishIndex++;
    } else if (p.category === 'home') {
        p.name = homeNames[homeIndex % homeNames.length];
        homeIndex++;
    }
});

fs.writeFileSync('products.json', JSON.stringify(products, null, 2));
fs.writeFileSync('js/products.js', 'const products =  \n' + JSON.stringify(products, null, 2) + ';');
console.log('Products updated successfully!');
