import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import User from "@/models/User";
import ExchangeRateTrendData from "@/models/ExchangeRateTrendData";

export async function GET() {
  const handleTrendCalculation = (exchangeRateTrendData) => {
    let average = 0;
    exchangeRateTrendData.forEach((dataPoint) => {
      average = average + dataPoint;
    });
    average = average / (exchangeRateTrendData.length - 1);
    if (exchangeRateTrendData.length >= 16) {
      if (
        exchangeRateTrendData[exchangeRateTrendData.length - 1] <=
        average - 0.005
      ) {
        return {
          trend: "negative",
          message: "Exchange Rate is Trending Negatively",
        };
      }
    }

    if (
      exchangeRateTrendData[exchangeRateTrendData.length - 1] >
      average + 0.01
    ) {
      return {
        trend: "positive",
        message: "Exchange Rate is Trending Positively",
      };
    }
    if (exchangeRateTrendData.length >= 6) {
      if (
        (exchangeRateTrendData[exchangeRateTrendData.length - 1] -
          exchangeRateTrendData[exchangeRateTrendData.length - 2]) /
          15 >
          (exchangeRateTrendData[exchangeRateTrendData.length - 2] -
            exchangeRateTrendData[exchangeRateTrendData.length - 3]) /
            15 &&
        (exchangeRateTrendData[exchangeRateTrendData.length - 2] -
          exchangeRateTrendData[exchangeRateTrendData.length - 3]) /
          15 >
          (exchangeRateTrendData[exchangeRateTrendData.length - 3] -
            exchangeRateTrendData[exchangeRateTrendData.length - 4]) /
            15 &&
        (exchangeRateTrendData[exchangeRateTrendData.length - 3] -
          exchangeRateTrendData[exchangeRateTrendData.length - 4]) /
          15 >
          (exchangeRateTrendData[exchangeRateTrendData.length - 4] -
            exchangeRateTrendData[exchangeRateTrendData.length - 5]) /
            15 &&
        (exchangeRateTrendData[exchangeRateTrendData.length - 4] -
          exchangeRateTrendData[exchangeRateTrendData.length - 5]) /
          15 >
          (exchangeRateTrendData[exchangeRateTrendData.length - 5] -
            exchangeRateTrendData[exchangeRateTrendData.length - 6]) /
            15
      ) {
        return {
          trend: "positive",
          message:
            "The Rate at Which the Exchange Rate is Increasing Has Been Going Up Over The Past Hour",
        };
      }
    }
    return {
      trend: "neutral",
      message: "No Trend Identified",
    };
  };

  try {
    await connectToDatabase();
    const currentTime = new Date();

    // Fetch all users
    const users = await User.find({});

    if (!users.length) {
      console.log("No users found, skipping cron.");
      return NextResponse.json(
        { success: true, skipped: true, message: "No users found" },
        { status: 200 }
      );
    }

    // Loop over users sequentially to handle async calls safely
    for (const user of users) {
      const existingRateData = await ExchangeRateTrendData.findOne({
        from: user.from.slice(0, 3),
        to: user.to.slice(0, 3),
      });

      if (existingRateData) {
        let exchangeRateTrendData = existingRateData.storedExchangeRates;
        try {
          // Fetch exchange rate
          const scraperResponse = await fetch(
            `${
              process.env.NEXT_PUBLIC_BACKEND_URL
            }/api/scraper-cheerio?from=${user.from.slice(
              0,
              3
            )}&to=${user.to.slice(0, 3)}`
          );
          const rateData = await scraperResponse.json();
          const exchangeRate = Number(
            Number(Number(rateData.replace(/,/g, "")) / 1000).toFixed(5)
          );

          if (!exchangeRateTrendData.length) {
            exchangeRateTrendData = [exchangeRate];
          } else if (
            exchangeRateTrendData.length <= 192 &&
            exchangeRateTrendData.length > 0
          ) {
            exchangeRateTrendData.push(exchangeRate);
          } else {
            exchangeRateTrendData = exchangeRateTrendData.slice(1);
            exchangeRateTrendData.push(exchangeRate);
          }

          await ExchangeRateTrendData.findOneAndUpdate(
            { from: user.from.slice(0, 3), to: user.to.slice(0, 3) },
            { $set: { storedExchangeRates: exchangeRateTrendData } }
          );
          const trend = handleTrendCalculation(exchangeRateTrendData);
          const intervalDifference = currentTime - user.lastCheck;

          if (
            (exchangeRate * user.conversionAmount >= user.thresholdValue &&
              trend.trend === "neutral") ||
            (exchangeRate * user.conversionAmount >= user.thresholdValue &&
              !user.trendNotifications)
          ) {
            if (intervalDifference >= user.interval - 1000 * 60 * 3) {
              await User.findOneAndUpdate(
                {
                  email: user.email,
                  to: user.to,
                  from: user.from,
                  conversionAmount: user.conversionAmount,
                },
                { $set: { lastCheck: currentTime } }
              );
              try {
                // Send email
                const emailResponse = await fetch(
                  `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/send-email`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      email: user.email,
                      trend: "Exchange Rate Above Minimum Threshold",
                      exchangeRate: exchangeRate,
                      to: user.to,
                      from: user.from,
                      conversionAmount: user.conversionAmount,
                    }),
                  }
                );

                const emailResult = await emailResponse.json();
                console.log("Email sent:", emailResult);

                // Update lastCheck
              } catch (emailError) {
                console.error("Error sending email:", emailError);
              }
            }
          } else if (
            exchangeRate * user.conversionAmount >= user.thresholdValue &&
            trend.trend !== "neutral" &&
            user.trendNotifications
          ) {
            try {
              // Send email
              const emailResponse = await fetch(
                `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/send-email`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    email: user.email,
                    trend: `Exchange Rate Above Minimum Threshold & ${trend.message}`,
                    exchangeRate: exchangeRate,
                    to: user.to,
                    from: user.from,
                    conversionAmount: user.conversionAmount,
                  }),
                }
              );

              const emailResult = await emailResponse.json();
              console.log("Email sent:", emailResult);

              // Update lastCheck
            } catch (emailError) {
              console.error("Error sending email:", emailError);
            }
          } else if (
            exchangeRate * user.conversionAmount < user.thresholdValue &&
            trend.trend !== "neutral" &&
            user.trendNotifications
          ) {
            try {
              // Send email
              const emailResponse = await fetch(
                `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/send-email`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    email: user.email,
                    trend: trend.message,
                    exchangeRate: exchangeRate,
                    to: user.to,
                    from: user.from,
                    conversionAmount: user.conversionAmount,
                  }),
                }
              );

              const emailResult = await emailResponse.json();
              console.log("Email sent:", emailResult);

              // Update lastCheck
            } catch (emailError) {
              console.error("Error sending email:", emailError);
            }
          }
        } catch (scraperError) {
          console.error("Error fetching rates:", scraperError);
        }
      } else {
        const newRateData = await ExchangeRateTrendData.create({
          storedExchangeRates: [],
          from: user.from.slice(0, 3),
          to: user.to.slice(0, 3),
        });
        let exchangeRateTrendData = newRateData.storedExchangeRates;
        try {
          // Fetch exchange rate
          const scraperResponse = await fetch(
            `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/scraper-cheerio?from=${newRateData.from}&to=${newRateData.to}`
          );
          const rateData = await scraperResponse.json();
          const exchangeRate = Number(
            Number(Number(rateData.replace(/,/g, "")) / 1000).toFixed(5)
          );

          if (!exchangeRateTrendData.length) {
            exchangeRateTrendData = [exchangeRate];
          } else if (
            exchangeRateTrendData.length <= 192 &&
            exchangeRateTrendData.length > 0
          ) {
            exchangeRateTrendData.push(exchangeRate);
          } else {
            exchangeRateTrendData = exchangeRateTrendData.slice(1);
            exchangeRateTrendData.push(exchangeRate);
          }

          await ExchangeRateTrendData.findOneAndUpdate(
            { from: newRateData.from, to: newRateData.to },
            { $set: { storedExchangeRates: exchangeRateTrendData } }
          );
          const trend = handleTrendCalculation(exchangeRateTrendData);
          const intervalDifference = currentTime - user.lastCheck;

          if (
            (exchangeRate * user.conversionAmount >= user.thresholdValue &&
              trend.trend === "neutral") ||
            (exchangeRate * user.conversionAmount >= user.thresholdValue &&
              !user.trendNotifications)
          ) {
            if (intervalDifference >= user.interval - 1000 * 60 * 3) {
              await User.findOneAndUpdate(
                {
                  email: user.email,
                  to: user.to,
                  from: user.from,
                  conversionAmount: user.conversionAmount,
                },
                { $set: { lastCheck: currentTime } }
              );
              try {
                // Send email
                const emailResponse = await fetch(
                  `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/send-email`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      email: user.email,
                      trend: "Exchange Rate Above Minimum Threshold",
                      exchangeRate: exchangeRate,
                      to: user.to,
                      from: user.from,
                      conversionAmount: user.conversionAmount,
                    }),
                  }
                );

                const emailResult = await emailResponse.json();
                console.log("Email sent:", emailResult);

                // Update lastCheck
              } catch (emailError) {
                console.error("Error sending email:", emailError);
              }
            }
          } else if (
            exchangeRate * user.conversionAmount >= user.thresholdValue &&
            trend.trend !== "neutral" &&
            user.trendNotifications
          ) {
            try {
              // Send email
              const emailResponse = await fetch(
                `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/send-email`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    email: user.email,
                    trend: `Exchange Rate Above Minimum Threshold & ${trend.message}`,
                    exchangeRate: exchangeRate,
                    to: user.to,
                    from: user.from,
                    conversionAmount: user.conversionAmount,
                  }),
                }
              );

              const emailResult = await emailResponse.json();
              console.log("Email sent:", emailResult);

              // Update lastCheck
            } catch (emailError) {
              console.error("Error sending email:", emailError);
            }
          } else if (
            exchangeRate * user.conversionAmount < user.thresholdValue &&
            trend.trend !== "neutral" &&
            user.trendNotifications
          ) {
            try {
              // Send email
              const emailResponse = await fetch(
                `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/send-email`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    email: user.email,
                    trend: trend.message,
                    exchangeRate: exchangeRate,
                    to: user.to,
                    from: user.from,
                    conversionAmount: user.conversionAmount,
                  }),
                }
              );

              const emailResult = await emailResponse.json();
              console.log("Email sent:", emailResult);

              // Update lastCheck
            } catch (emailError) {
              console.error("Error sending email:", emailError);
            }
          }
        } catch (scraperError) {
          console.error("Error fetching rates:", scraperError);
        }
      }
    }
    return NextResponse.json(
      { success: true, message: "Rates checked & users emailed as needed" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Unexpected error while getting rates:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
