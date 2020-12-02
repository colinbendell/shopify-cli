const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
Promise.delay = sleep;

module.exports = {
    sleep
};
