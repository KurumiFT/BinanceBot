const ccxt = require('ccxt');

const apiKey = ''; // Api ключ
const secret = ''; // Секретный ключ

const symbols = [
    { symbol : 'SUSHIUSDT', pair: '' }, // Пару оставляем пустой
    { symbol : 'ADAUSDT', pair : '' },
    { symbol : 'BTCUSDT', pair : '' },
]

let precisions = {

}

const exchange = new ccxt.binance({
    apiKey,
    secret,
    options: {
      adjustForTimeDifference: true, 
      defaultType: 'futures',
    },
});
// exchange.set_sandbox_mode(true)

const helper_trigger = 0.01

let start_time;
let market;

let ignore_ids = [];
let helper_ids = [];

async function closeHelperPositions(target_symbol, position_side, quantity) {
    let orders = [];
    let filled_qty = 0;

    let ignored_orders = [];
    for(let i = 0; i < helper_ids.length; i++) {
        try { 
            const order_data = await exchange.fapiPrivateGetOrder({symbol : target_symbol, orderId : helper_ids[i]});
            orders.push(order_data);
        } catch {
            ignored_orders.push(helper_ids[i]);
        }
    }

    helper_ids = helper_ids.filter(item => {
        return !(ignored_orders.includes(item));
    })

    let queue_orders = orders.filter((item) => {
        return item.type == 'STOP_MARKET' && item.status == 'NEW' && item.positionSide == position_side;
    })

    let proceeded_orders = orders.filter((item) => {
        return item.status == 'FILLED' && item.positionSide == position_side; 
    })

    queue_orders = queue_orders.sort( (a, b) => {
        return (parseInt(a.time) - parseInt(b.time));
    })

    for (let i = 0; i < queue_orders.length; i++) {
        if (parseFloat(queue_orders[i].origQty) <= quantity - filled_qty) {
            helper_ids = helper_ids.filter( item => {
                return item != queue_orders[i].orderId;
            })

            exchange.fapiPrivateDeleteOrder({ symbol : target_symbol, orderId : queue_orders[i].orderId }) ;
            filled_qty =  filled_qty + parseFloat(queue_orders[i].origQty);
            if (filled_qty == quantity) { break };
        }
    }

    if (filled_qty >= quantity) { return }

    proceeded_orders = proceeded_orders.sort( (a, b) => {
        return (parseInt(a.time) - parseInt(b.time));
    })

    for (let i = 0; i < proceeded_orders.length; i++) {
        if (parseFloat(proceeded_orders[i].origQty) <= quantity - filled_qty) {
            helper_ids = helper_ids.filter( item => {
                return item != proceeded_orders[i].orderId;
            })

            ignore_ids.push(proceeded_orders[i].orderId);

            exchange.fapiPrivatePostOrder({ symbol : target_symbol, type : 'market', quantity : parseFloat(proceeded_orders[i].origQty), side : (proceeded_orders[i].positionSide == 'SHORT' ? 'BUY' : 'SELL'), positionSide : proceeded_orders[i].positionSide}).then(order_data => {
                ignore_ids.push(order_data.orderId);
                console.log(order_data)
            });
            filled_qty =  filled_qty + parseFloat(proceeded_orders[i].origQty);
            if (filled_qty == quantity) { break };
        }
    }
}

async function loop(target_symbol, pair) {
    let orders = (await exchange.fapiPrivateGetAllOrders({ symbol : target_symbol, limit : 50 })).filter( item => {
        return parseInt(item.time) >= start_time && !(ignore_ids.includes(item.orderId)) && (item.type == 'MARKET') && !(helper_ids.includes(item.orderId)) ;
    }) ;

    orders.forEach((order) => {
        // console.log(order);
        ignore_ids.push(order.orderId);

        if (order.positionSide == 'LONG') {
            if (order.side == 'BUY') {
                const price = (parseFloat(order.avgPrice) * (1 - helper_trigger)).toFixed(precisions[target_symbol] );
                // const price = exchange.priceToPrecision(pair, parseFloat(order.avgPrice) * (1 - helper_trigger));
                console.log(price);
                exchange.fapiPrivatePostOrder({symbol : target_symbol, type : 'stop_market', side : 'SELL', quantity : parseFloat(order.origQty), stopPrice : price, positionSide : "SHORT", timeInForce : "GTC"}).then(res => {
                    helper_ids.push(res.orderId);
                });
            }else {
                closeHelperPositions(target_symbol, 'SHORT', parseFloat(order.origQty));
            }
        }else if (order.positionSide == 'SHORT') {
            if (order.side == 'SELL') {
                const price = (parseFloat(order.avgPrice) * (1 + helper_trigger)).toFixed(precisions[target_symbol] );
                // const price = exchange.priceToPrecision(pair, parseFloat(order.avgPrice) * (1 + helper_trigger));
                console.log(price);
                exchange.fapiPrivatePostOrder({symbol : target_symbol, type : 'stop_market', side : 'BUY', quantity : parseFloat(order.origQty), stopPrice : price, positionSide : "LONG", timeInForce : "GTC"}).then(res => {
                    helper_ids.push(res.orderId);
                });
            }else {
                closeHelperPositions(target_symbol, 'LONG', parseFloat(order.origQty));
            }   
        }
    })
}

async function hedgeMode(symbol) {
    try {
       await exchange.setPositionMode(true, symbol);
    }catch {

    }
}

exchange.publicGetTime().then(res => {
    exchange.loadMarkets().then(() => {
        for (let symbol in exchange.markets) {
            const item = exchange.markets[symbol];

            for (let i = 0; i < symbols.length; i ++ ){
                if (item.info.symbol == symbols[i].symbol) { 
                    precisions[item.info.symbol] = parseInt(item.info.pricePrecision);
                    break;
                 }
            }
        }

        for(let i = 0; i < symbols.length; i++) {
            hedgeMode(symbols[i].symbol);
        }

        start_time = res.serverTime;

        async function loopCreator(symbol, pair) {
            while (true) {
                await loop(symbol, pair);
            }
        }  

        for(let i = 0; i < symbols.length; i++) {
            loopCreator(symbols[i].symbol, symbols[i].pair);
        }
    }) ;
});

async function closeAllPositions() {
    for (let i = 0; i < symbols.length; i++) {
        await closeHelperPositions(symbols[i].symbol, 'SHORT', 1000000)
        await closeHelperPositions(symbols[i].symbol, 'LONG', 1000000)
    }
}

process.on('SIGINT', () => {
    closeAllPositions()

    setTimeout(() => { process.exit() }, 5000); 
});