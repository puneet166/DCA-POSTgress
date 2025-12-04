const botsModel = require('../models/bots');

async function validateBotCreationRules({
  userId,
  planName,
  activeSub,
  value   // contains { pair }
}) {
  const normalizedPlan = (planName || "").toLowerCase();

  // Total bots for user
  const totalBots = await botsModel.countBots(userId);

  //  Existing bot for same pair
  const existingBotForPair = await botsModel.findBotByPair({
    userId,
    pair: value.pair
  });

  // Must have subscription
  if (!activeSub) {
    return {
      success: false,
      status: 404,
      message: "You have no active plan to create Bot."
    };
  }

  const isStarter = normalizedPlan.includes("starter");
  const isFree = normalizedPlan.includes("free");
  const isPro = normalizedPlan.includes("pro");

  // 4️⃣ Starter / Free → Only 1 bot allowed
  if (isStarter || isFree) {
    if (totalBots >= 1) {
      return {
        success: false,
        status: 409,
        message: "You can only create one bot under the Starter/Free plan."
      };
    }
    return { success: true };
  }

  //  Pro plan → Only one bot per pair
  if (isPro) {
    if (existingBotForPair) {
      return {
        success: false,
        status: 409,
        message: `You already have a bot for ${value.pair}. Only one bot per pair allowed under Pro plan.`
      };
    }
    return { success: true };
  }

  //  Other plans → limit by botCount
  if (activeSub.botCount !== null && totalBots >= activeSub.botCount) {
    return {
      success: false,
      status: 409,
      message: "You exceed bot creation limit. Upgrade your plan."
    };
  }

  if (existingBotForPair) {
    return {
      success: false,
      status: 409,
      message: `Not allowed, as you already created a bot for ${value.pair}.`
    };
  }

  return { success: true };
}

module.exports =  validateBotCreationRules ;

