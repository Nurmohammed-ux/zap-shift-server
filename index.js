const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;
const app = express();
// stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

try {
  const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

  initializeApp({
    credential: cert(serviceAccount),
  });
  console.log("Firebase initialized");
} catch (err) {
  console.error(err);
}

function generateTrackingId() {
  const prefix = "TRK";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomString = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `${prefix}-${date}-${randomString}`;
}

// middleware
app.use(cors());
app.use(express.json());

//Jwt middleware
const verifyFirebaseToken = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return res
        .status(401)
        .send({ message: "Unauthorized Access: No token provided" });
    }

    const token = authorization.split(" ")[1];

    const decoded = await getAuth().verifyIdToken(token);
    req.token_email = decoded.email;
    next();
  } catch (err) {
    console.error("Token verification error:", err.message);
    return res.status(401).send({
      message: "Invalid token",
      error: err.message,
    });
  }
};

// mongodb
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.jd5uu0i.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const database = client.db("zap_shift_db");
const userCollections = database.collection("users");
const parcelCollections = database.collection("parcels");
const paymentCollections = database.collection("payments");
const riderCollections = database.collection("riders");
const trackingCollections = database.collection("trackings");

client
  .connect()
  .then(() => {
    console.log("ZapShift server side connected to MongoDB");
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err);
  });

app.get("/", (req, res) => {
  res.send("ZapShift server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "ZapShift API is running",
  });
});

//middleware with data access for admin and verify that
//  must be used after verifyFirebaseToken
const verifyAdmin = async (req, res, next) => {
  const email = req.token_email;
  const query = { email };
  const user = await userCollections.findOne(query);

  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }

  next();
};

const logTracking = async (trackingId, status) => {
  const log = {
    trackingId,
    status,
    details: status.split("-").join(" "),
    createdAt: new Date(),
  };
  const result = await trackingCollections.insertOne(log);
  return result;
};

// users related api
app.post("/users", async (req, res) => {
  try {
    const user = req.body;
    user.role = "user";
    user.createdAt = new Date();
    const email = user.email;
    const existingUser = await userCollections.findOne({ email });

    if (existingUser) {
      return res.send({ message: "User already exists" });
    }

    const result = await userCollections.insertOne(user);
    res.send(user);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.get("/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const searchText = req.query.searchText;

    if (searchText && typeof searchText !== "string") {
      return res.status(400).send({
        message: "Invalid search text",
      });
    }

    const query = {};

    if (searchText) {
      const safeSearchText = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      query.$or = [
        {
          displayName: {
            $regex: safeSearchText,
            $options: "i",
          },
        },
        {
          email: {
            $regex: safeSearchText,
            $options: "i",
          },
        },
      ];
    }

    const result = await userCollections
      .find(query)
      .sort({ createdAt: -1 })
      .limit(7)
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

app.get("users/:id", async (req, res) => {});

app.get("/users/:email/role", async (req, res) => {
  try {
    const email = req.params.email;
    const query = { email };
    const user = await userCollections.findOne(query);
    res.send({ role: user?.role || "user" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.patch(
  "/users/:id/role",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          ...roleInfo,
        },
      };
      const result = await userCollections.updateOne(query, updateDoc);

      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({
        message: error.message,
      });
    }
  },
);

// Parcels Api
// for my-parcels and assigned rider
app.get("/parcels", async (req, res) => {
  try {
    const query = {};
    const { email, deliveryStatus } = req.query;

    if (email) {
      query.senderEmail = email;
    }

    if (deliveryStatus) {
      const statuses = deliveryStatus.split(",");
      query.deliveryStatus = {
        $in: statuses,
      };
    }

    const result = await parcelCollections
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

// get for assigned deliveries and completed deliveries
app.get("/parcels/rider", async (req, res) => {
  try {
    const { riderEmail, deliveryStatus } = req.query;

    if (!riderEmail) {
      return res.status(400).send({ message: "riderEmail is required" });
    }

    const query = {
      riderEmail: riderEmail, // Only match parcels explicitly assigned to this rider
    };

    if (deliveryStatus) {
      const statuses = deliveryStatus.split(",");
      query.deliveryStatus = {
        $in: statuses,
      };
    }

    const result = await parcelCollections
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

app.get("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const result = await parcelCollections.findOne(query);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// from pricing, logTracking, created trackingId
app.post("/parcels", async (req, res) => {
  try {
    const parcel = req.body;
    const trackingId = generateTrackingId();

    parcel.createdAt = new Date();
    parcel.trackingId = trackingId;

    // 🌟 3. INSERT LOG TRACKING HERE
    await logTracking(trackingId, "parcel-create");

    const result = await parcelCollections.insertOne(parcel);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// TODO: rename this to be specific like /parcels/:id/assign from assignedRider, logTracking
app.patch("/parcels/:id", async (req, res) => {
  try {
    const { riderId, riderName, riderContact, riderEmail, trackingId } =
      req.body;
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const updateDoc = {
      $set: {
        deliveryStatus: "driver-assigned",
        riderId: riderId,
        riderName: riderName,
        riderEmail: riderEmail,
        riderContact: riderContact,
      },
    };

    const result = await parcelCollections.updateOne(query, updateDoc);

    // update rider work status
    const riderQuery = { _id: new ObjectId(riderId) };
    const updatedRiderDoc = {
      $set: {
        workStatus: "in-transit",
      },
    };

    const riderResult = await riderCollections.updateOne(
      riderQuery,
      updatedRiderDoc,
    );

    // 🌟 3. INSERT LOG TRACKING HERE
    await logTracking(trackingId, "driver-assigned");

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// from assignedDeliveries, logTracking
app.patch("/parcels/:id/status", async (req, res) => {
  try {
    const { deliveryStatus, riderEmail, trackingId } = req.body;
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    let updateDoc = {
      $set: {
        deliveryStatus: deliveryStatus,
      },
    };

    // If a rider is rejecting the parcel, mark it as driver_rejected, clear assignment, and blacklist the rider
    if (deliveryStatus === "driver-rejected" && riderEmail) {
      updateDoc = {
        $set: {
          deliveryStatus: "driver-rejected",
          riderId: null,
          riderName: null,
          riderEmail: null,
          riderContact: null,
        },
        $push: { rejectedRiders: riderEmail },
      };
    }

    const result = await parcelCollections.updateOne(query, updateDoc);

    // If the parcel is successfully marked as delivered, update the rider's workStatus to available
    if (deliveryStatus === "parcel-delivered" && riderEmail) {
      await riderCollections.updateOne(
        { email: riderEmail },
        { $set: { workStatus: "available" } },
      );
    }

    // 🌟 3. INSERT LOG TRACKING HERE
    await logTracking(trackingId, deliveryStatus);

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.delete("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const result = await parcelCollections.deleteOne(query);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// Payment and session related Api
app.post("/payment-checkout-session", async (req, res) => {
  try {
    const paymentInfo = req.body;
    const amount = parseInt(paymentInfo.cost) * 100;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "USD",
            unit_amount: amount,
            product_data: {
              name: paymentInfo.parcelName,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: paymentInfo.senderEmail,
      mode: "payment",
      metadata: {
        parcelId: paymentInfo.parcelId,
        parcelName: paymentInfo.parcelName,
        trackingId: paymentInfo.trackingId,
      },
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });
    // console.log(session);
    res.send({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

// // old
// app.post("/create-checkout-session", async (req, res) => {
//   try {
//     const paymentInfo = req.body;
//     const amount = parseInt(paymentInfo.cost) * 100;

//     const session = await stripe.checkout.sessions.create({
//       line_items: [
//         {
//           price_data: {
//             currency: "USD",
//             unit_amount: amount,
//             product_data: {
//               name: paymentInfo.parcelName,
//             },
//           },
//           quantity: 1,
//         },
//       ],
//       customer_email: paymentInfo.senderEmail,
//       mode: "payment",
//       metadata: {
//         parcelId: paymentInfo.parcelId,
//       },
//       success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
//       cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
//     });
//     console.log(session);
//     res.send({ url: session.url });
//   } catch (error) {
//     console.error(error);
//     res.status(500).send({ message: error.message });
//   }
// });

// logTracking
app.patch("/payment-success", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === "paid") {
      const id = session.metadata.parcelId;
      const query = { _id: new ObjectId(id) };

      // Check if this payment record already exists to prevent duplicates
      const existingPayment = await paymentCollections.findOne({
        sessionId: session.id,
      });

      let resultPayment = existingPayment;
      let result = null; // Declare result beforehand
      let trackingId;

      if (!existingPayment) {
        // don't create new trackingId,use existing trackingId paymentInfo's metadata tracking id

        // trackingId = generateTrackingId();
        trackingId = session.metadata.trackingId;

        // 1. Update parcel status and payment info only if not already processed
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "ready-for-pickup",
            transactionId: session.payment_intent,
            trackingId: trackingId,
            paidAt: new Date(),
          },
        };

        result = await parcelCollections.updateOne(query, update);

        // 2. Insert payment record once
        const paymentRecord = {
          parcelId: session.metadata.parcelId,
          transactionId: session.payment_intent,
          sessionId: session.id,
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail:
            session.customer_details?.email || session.customer_email,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
        };

        resultPayment = await paymentCollections.insertOne(paymentRecord);

        // 🌟 3. INSERT LOG TRACKING HERE
        await logTracking(trackingId, "ready-for-pickup");
      } else {
        // If it already exists, fetch the existing trackingId from the parcel if needed
        const parcel = await parcelCollections.findOne(query);
        trackingId = parcel?.trackingId;
      }

      return res.send({
        success: true,
        message: existingPayment
          ? "Payment already processed"
          : "Payment processed successfully",
        modifyParcel: result,
        trackingId: trackingId,
        transactionId: session.payment_intent,
        paymentInfo: resultPayment,
      });
    }

    res.send({ success: false, message: "Payment not completed" });
  } catch (error) {
    console.error("Payment success route error:", error);
    res.status(500).send({ message: error.message });
  }
});

app.get("/payments", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.token_email;

    if (email !== req.token_email) {
      return res.status(403).send({ message: "Forbidden access" });
    }

    const result = await paymentCollections
      .aggregate([
        {
          $match: {
            customerEmail: email,
          },
        },
        {
          $addFields: {
            parcelObjectId: {
              $toObjectId: "$parcelId",
            },
          },
        },
        {
          $lookup: {
            from: "parcels",
            localField: "parcelObjectId",
            foreignField: "_id",
            as: "parcel",
          },
        },
        {
          $unwind: "$parcel",
        },
        {
          $sort: { paidAt: -1 },
        },
      ])
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// Riders related apis

app.get("/riders", async (req, res) => {
  try {
    const { status, district, workStatus } = req.query;
    const query = {};

    if (status) {
      query.status = status;
    }
    if (district) {
      query.district = district;
    }
    if (workStatus) {
      query.workStatus = workStatus;
    }

    const cursor = riderCollections.find(query);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

app.post("/riders", async (req, res) => {
  try {
    const rider = req.body;

    const existingRider = await riderCollections.findOne({
      email: rider.email,
    });

    if (existingRider) {
      return res.status(409).send({
        message: "Rider application already exists for this email.",
        insertedId: null,
      });
    }

    // 2. If not, proceed with insertion
    rider.status = "pending";
    rider.createdAt = new Date();

    const result = await riderCollections.insertOne(rider);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: error.message });
  }
});

// app.patch("/riders/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
//   try {
//     const id = req.params.id;
//     const status = req.body.status;
//     const email = req.body.email;

//     if (email !== req.token_email) {
//       return res.status(403).send({ message: "Forbidden access" });
//     }

//     const query = { _id: new ObjectId(id) };
//     const updateDoc = {
//       $set: {
//         status: status,
//         workStatus: "available",
//       },
//     };
//     const result = await riderCollections.updateOne(query, updateDoc);

//     if (status === "approved") {
//       const userQuery = { email };
//       const updateUser = {
//         $set: {
//           role: "rider",
//         },
//       };
//       const updateResult = await userCollections.updateOne(
//         userQuery,
//         updateUser,
//       );
//     }
//     res.send(result);
//   } catch (error) {
//     res.status(500).send({ message: error.message });
//   }
// });

app.patch("/riders/:id", verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;

    const rider = await riderCollections.findOne({
      _id: new ObjectId(id),
    });

    if (!rider) {
      return res.status(404).send({
        message: "Rider not found",
      });
    }

    const updateDoc = {
      $set: {
        status,
      },
    };

    if (status === "approved") {
      updateDoc.$set.workStatus = "available";

      await userCollections.updateOne(
        { email: rider.email },
        {
          $set: {
            role: "rider",
          },
        },
      );
    }

    const result = await riderCollections.updateOne(
      { _id: new ObjectId(id) },
      updateDoc,
    );

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: error.message,
    });
  }
});

app.delete(
  "/riders/:id",
  verifyFirebaseToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const email = req.query.email;

      if (email !== req.token_email) {
        return res.status(403).send({ message: "Forbidden access" });
      }

      const query = { _id: new ObjectId(id) };
      const result = await riderCollections.deleteOne(query);
      res.send(result);
    } catch (error) {
      console.error(error);
      res.status(500).send({ message: error.message });
    }
  },
);

//  Trackings related apis
app.get("/trackings/:trackingId/logs", async (req, res) => {
  try {
    const trackingId = req.params.trackingId;
    const query = { trackingId };
    const result = await trackingCollections.find(query).toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: error.message });
  }
});

app.listen(port, () => {
  console.log(`ZapShift app listening on port ${port}`);
});
