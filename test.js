const ccxt = require('ccxt');

const apiKey = 'lsJ22kZJuYgka1eu0ftHoJIPTQzZDfHMSs4OYLCdU54RpJxUxg9WFXReLJxcZUSY';
const secret = 'wLhJUworGfIuyiDJM8H2TO42fXOF1MQbAApfHlt55gvBBex3017shMJwxflqeJ4o';

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

let work = true;

let start_time;

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

async function loop() {
    let orders = (await exchange.fapiPrivateGetAllOrders({ limit : 50 })).filter( item => {
        return parseInt(item.time) >= start_time && 
        !(ignore_ids.includes(item.orderId)) && 
        !(helper_ids.includes(item.orderId)) &&
        (item.status == 'FILLED');
    });

    console.log(orders);
    orders.forEach((order) => {
        ignore_ids.push(order.orderId);

        const target_symbol = order.symbol
        if (order.positionSide == 'LONG') {
            if (order.side == 'BUY') {
                exchange.fapiPublicGetTickerPrice({symbol : target_symbol}).then(res => {
                    const price = (parseFloat(res.price) * (1 - helper_trigger)).toFixed(precisions[target_symbol] );
                    exchange.fapiPrivatePostOrder({symbol : target_symbol, type : 'stop_market', side : 'SELL', quantity : parseFloat(order.origQty), stopPrice : price, positionSide : "SHORT", timeInForce : "GTC"}).then(res => {
                        helper_ids.push(res.orderId);
                    });
                })
            }else {
                closeHelperPositions(target_symbol, 'SHORT', parseFloat(order.origQty));
            }
        }else if (order.positionSide == 'SHORT') {
            if (order.side == 'SELL') {
                exchange.fapiPublicGetTickerPrice({symbol : target_symbol}).then(res => {
                    const price = (parseFloat(res.price) * (1 + helper_trigger)).toFixed(precisions[target_symbol] );

                    exchange.fapiPrivatePostOrder({symbol : target_symbol, type : 'stop_market', side : 'BUY', quantity : parseFloat(order.origQty), stopPrice : price, positionSide : "LONG", timeInForce : "GTC"}).then(res => {
                        helper_ids.push(res.orderId);
                    });
                })
            }else {
                closeHelperPositions(target_symbol, 'LONG', parseFloat(order.origQty));
            }   
        }
    })
}

async function programLoop() {
    while (work) {
        await loop()
    }
}

async function hedgeMode() {
    try {
       await exchange.fapiPrivatePostPositionSideDual({ dualSidePosition : "true" });
    }catch {

    }
}

exchange.publicGetTime().then(data => {
    start_time = data.serverTime

    exchange.loadMarkets().then(()=>{
        hedgeMode()
    
        for (let symbol in exchange.markets) {
            const item = exchange.markets[symbol];
    
            if (parseInt(item.info.pricePrecision)) {
                precisions[item.info.symbol] = parseInt(item.info.pricePrecision);
            }
        }
    
        programLoop()
    })
})

async function closeAllPositions() {
    Object.keys(precisions).forEach(item => {
        closeHelperPositions(item, 'SHORT', 1000000)
        closeHelperPositions(item, 'LONG', 1000000)
    })
}

process.on('SIGINT', () => {
    work = false;
    closeAllPositions();

    setTimeout(() => { process.exit() }, 10000); 
});

// programLoop()