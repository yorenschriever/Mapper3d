#include <inttypes.h>
#include <stdlib.h>
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "protocol.h"

static const char *TAG = "mapper3d";
static const uint8_t colors[6][3] = {
    {1, 0, 0}, {0, 1, 0}, {0, 0, 1},
    {1, 1, 0}, {0, 1, 1}, {1, 0, 1}
};

void app_main(void)
{
    const unsigned int count = CONFIG_MAPPER_LED_COUNT;
    const int64_t period_us = count <= 2000 ? 120000 : 360000;
    uint8_t (*words)[MAPPER_CODE_WORDS] = malloc(count * sizeof(*words));
    if (!words) {
        ESP_LOGE(TAG, "Insufficient memory for %u LED codewords", count);
        return;
    }
    for (unsigned int i = 0; i < count; ++i) {
        if (!mapper_encode(i, count, words[i])) {
            ESP_LOGE(TAG, "Failed to encode LED %u", i);
            free(words);
            return;
        }
    }
    led_strip_config_t strip_config = {
        .strip_gpio_num = CONFIG_MAPPER_LED_GPIO,
        .max_leds = count,
        .led_model = LED_MODEL_WS2812,
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10000000,
        .mem_block_symbols = 64,
        .flags.with_dma = false,
    };
    led_strip_handle_t strip;
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &strip));
    ESP_LOGI(TAG, "Encoding %u LEDs; symbol period %" PRId64 " ms", count, period_us / 1000);
    int64_t deadline = esp_timer_get_time();
    for (unsigned int position = 0;; position = (position + 1) % MAPPER_FRAME_SYMBOLS) {
        for (unsigned int i = 0; i < count; ++i) {
            const uint8_t *color = colors[mapper_frame_symbol(words[i], position)];
            ESP_ERROR_CHECK(led_strip_set_pixel(strip, i,
                color[0] * CONFIG_MAPPER_LED_BRIGHTNESS,
                color[1] * CONFIG_MAPPER_LED_BRIGHTNESS,
                color[2] * CONFIG_MAPPER_LED_BRIGHTNESS));
        }
        ESP_ERROR_CHECK(led_strip_refresh(strip));
        deadline += period_us;
        int64_t remaining = deadline - esp_timer_get_time();
        if (remaining <= 0) {
            ESP_LOGE(TAG, "LED update exceeded symbol period; stopping");
            ESP_ERROR_CHECK(led_strip_clear(strip));
            free(words);
            return;
        }
        vTaskDelay(pdMS_TO_TICKS((remaining + 999) / 1000));
    }
}
